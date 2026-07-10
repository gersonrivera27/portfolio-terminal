// Servidor del portafolio con terminal real enjaulada en Docker.
// Cada sesión WebSocket lanza un contenedor efímero, aislado y con límites.

const path = require('path');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

// ---------- Configuración ----------
const PORT = process.env.PORT || 3000;
const IMAGE = process.env.SANDBOX_IMAGE || 'portfolio-sandbox';
const MAX_SESSIONS = 10;         // sesiones simultáneas en total
const MAX_PER_IP = 2;            // sesiones simultáneas por IP
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos por sesión
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;     // 3 minutos sin teclear
const CONTAINER_LABEL = 'portfolio-sandbox=1';
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'sessions.jsonl');

// ---------- Log estructurado (JSONL, ingerible con Loki/Grafana) ----------
fs.mkdirSync(LOG_DIR, { recursive: true });
function logEvent(event, fields) {
  const entry = { ts: new Date().toISOString(), event, ...fields };
  fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', () => {});
}

// ---------- Libro de visitas ----------
// El visitante escribe `firmar <mensaje>` (o `sign`) dentro del sandbox.
// El comando lo intercepta ESTE servidor desde el stream de teclado; el
// contenedor solo tiene un stub silencioso. El mensaje nunca sale del
// contenedor: nace aquí, sanitizado, con límites por sesión y por IP.
const DATA_DIR = path.join(__dirname, 'data');
const GUESTBOOK_LOG = path.join(LOG_DIR, 'guestbook.jsonl');
const GUESTBOOK_FILE = path.join(DATA_DIR, 'libro-visitas.txt');
const GB_MAX_LEN = 140;
const GB_PER_IP_DAY = 3;
const GB_SHOWN = 50;

fs.mkdirSync(DATA_DIR, { recursive: true });

let guestbook = [];
try {
  guestbook = fs.readFileSync(GUESTBOOK_LOG, 'utf8')
    .split('\n').filter(Boolean)
    .flatMap((l) => {
      try { const e = JSON.parse(l); return e && e.msg ? [e] : []; } catch (_) { return []; }
    });
} catch (_) {}

function renderGuestbook() {
  const header = [
    '╔═══════════════════════════════════════════════════╗',
    '║         Libro de visitas  ·  Guestbook            ║',
    '╚═══════════════════════════════════════════════════╝',
    '',
    'Firma con:  firmar <tu mensaje>     (una por sesión)',
    'Sign with:  sign <your message>     (one per session)',
    '',
    '─────────────────────────────────────────────────────',
  ];
  const entries = guestbook.slice(-GB_SHOWN).reverse()
    .map((e) => `${(e.ts || '').slice(0, 10)}  "${e.msg}"`);
  const body = entries.length ? entries : ['(todavía no hay firmas — sé el primero / be the first)'];
  // Escritura in-place (mismo inodo): los sandboxes ya montados ven la
  // firma nueva al instante sin reiniciar nada.
  fs.writeFileSync(GUESTBOOK_FILE, header.concat(body, '').join('\n'));
}
renderGuestbook();

function sanitizeSignature(raw) {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ') // sin caracteres de control ni escapes
    .replace(/\s+/g, ' ')
    .trim();
}

function addSignature(entry) {
  guestbook.push(entry);
  fs.appendFile(GUESTBOOK_LOG, JSON.stringify(entry) + '\n', () => {});
  renderGuestbook();
}

const GB_MSG = {
  es: {
    usage: '\x1b[33mUso: firmar tu mensaje aquí   (sin comillas, máx 140 caracteres)\x1b[0m',
    thanks: '\x1b[32m✍  ¡Gracias! Tu firma quedó en el libro de visitas → cat ~/libro-visitas.txt\x1b[0m',
    already: '\x1b[33mYa firmaste en esta sesión. ¡Gracias!\x1b[0m',
    limit: '\x1b[33mLímite de firmas por hoy alcanzado desde tu conexión.\x1b[0m',
    tooLong: `\x1b[33mTu mensaje supera los ${GB_MAX_LEN} caracteres.\x1b[0m`,
  },
  en: {
    usage: '\x1b[33mUsage: sign your message here   (no quotes needed, max 140 chars)\x1b[0m',
    thanks: '\x1b[32m✍  Thanks! Your signature is in the guestbook → cat ~/english/guestbook.txt\x1b[0m',
    already: '\x1b[33mYou already signed in this session. Thanks!\x1b[0m',
    limit: '\x1b[33mDaily signature limit reached from your connection.\x1b[0m',
    tooLong: `\x1b[33mYour message is over ${GB_MAX_LEN} characters.\x1b[0m`,
  },
  pt: {
    usage: '\x1b[33mUso: sign sua mensagem aqui   (sem aspas, máx. 140 caracteres)\x1b[0m',
    thanks: '\x1b[32m✍  Obrigado! Sua assinatura está no livro de visitas → cat ~/english/guestbook.txt\x1b[0m',
    already: '\x1b[33mVocê já assinou nesta sessão. Obrigado!\x1b[0m',
    limit: '\x1b[33mLimite diário de assinaturas atingido da sua conexão.\x1b[0m',
    tooLong: `\x1b[33mSua mensagem passa de ${GB_MAX_LEN} caracteres.\x1b[0m`,
  },
};

const signaturesByIpDay = new Map();

function notify(ws, text) {
  try { ws.send(`\r\n${text}\r\n`); } catch (_) {}
}

// ---------- Comprobaciones de arranque ----------
// Asíncronas y con timeout: si el CLI de docker se cuelga (daemon caído o
// a medio arrancar), no debe bloquear el arranque del servidor.
exec(`docker image inspect ${IMAGE}`, { timeout: 5000 }, (err) => {
  if (err) {
    console.error(`[!] Docker no responde o la imagen "${IMAGE}" no existe.`);
    console.error(`[!] Construye la imagen con: cd sandbox && docker build -t ${IMAGE} .`);
    console.error('[!] El servidor seguirá corriendo, pero las sesiones fallarán.');
  }
});

// Limpia contenedores huérfanos de una ejecución anterior (crash, pm2 restart...)
exec(`docker ps -aq --filter label=${CONTAINER_LABEL}`, { timeout: 5000 }, (err, stdout) => {
  const ids = (stdout || '').trim();
  if (!err && ids) {
    console.log(`[*] Limpiando ${ids.split('\n').length} contenedor(es) huérfano(s)...`);
    exec(`docker rm -f ${ids.split('\n').join(' ')}`, { timeout: 10000 }, () => {});
  }
});

// ---------- Servidor HTTP ----------
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// Últimas firmas para la web (nunca se exponen las IPs)
app.get('/api/guestbook', (req, res) => {
  res.json(
    guestbook.slice(-20).reverse().map((e) => ({ ts: e.ts, msg: e.msg, lang: e.lang }))
  );
});

const server = http.createServer(app);

// ---------- WebSocket -> Docker ----------
const wss = new WebSocketServer({ server, path: '/terminal' });

let activeSessions = 0;
const sessionsByIp = new Map();
const activeContainers = new Set();

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// Prefijos de IP adicionales desde los que se confía en los headers de proxy.
// Útil cuando cloudflared corre en Docker y llega con IP del bridge, p. ej.:
//   TRUSTED_PROXIES="172.17."       (bridge por defecto de Docker)
//   TRUSTED_PROXIES="192.168.1.24"  (la propia Pi)
const TRUSTED_PROXIES = (process.env.TRUSTED_PROXIES || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function isTrustedProxy(addr) {
  if (isLoopback(addr)) return true;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return TRUSTED_PROXIES.some((p) => a.startsWith(p));
}

function clientIp(req) {
  // Solo confiamos en los headers de proxy cuando la conexión viene del
  // tunnel (loopback o un proxy listado en TRUSTED_PROXIES). Si alguien
  // llega directo al puerto 3000, esos headers son falsificables.
  const remote = req.socket.remoteAddress || 'unknown';
  if (!isTrustedProxy(remote)) return remote;
  return (
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    remote
  );
}

function visitorLang(req) {
  // Idioma elegido en la web (?lang=xx). Validado contra lista blanca:
  // este valor termina como variable de entorno del contenedor.
  try {
    const q = new URL(req.url, 'http://localhost').searchParams.get('lang');
    if (q === 'en' || q === 'pt') return q;
  } catch (_) {}
  return 'es';
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const lang = visitorLang(req);

  if (activeSessions >= MAX_SESSIONS) {
    ws.send('\r\n\x1b[31mServidor lleno. Intenta de nuevo en unos minutos.\x1b[0m\r\n');
    ws.close();
    return;
  }
  if ((sessionsByIp.get(ip) || 0) >= MAX_PER_IP) {
    ws.send('\r\n\x1b[31mDemasiadas sesiones desde tu conexión.\x1b[0m\r\n');
    ws.close();
    return;
  }

  activeSessions++;
  sessionsByIp.set(ip, (sessionsByIp.get(ip) || 0) + 1);

  const containerName = `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeContainers.add(containerName);
  console.log(`[+] Nueva conexión desde ${ip} (${lang}) -> ${containerName} (Activos: ${activeSessions}/${MAX_SESSIONS})`);
  logEvent('session_start', { ip, session: containerName, lang });

  // Contenedor desechable, sin red, solo lectura, sin privilegios, con límites.
  const dockerArgs = [
    'run', '-it', '--rm', '--init',
    '--name', containerName,
    '--label', CONTAINER_LABEL,
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m',
    '--memory', '64m',
    '--memory-swap', '64m',
    '--cpus', '0.5',
    '--pids-limit', '50',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--user', 'visitante',
    '-e', `VISITOR_LANG=${lang}`,
    // Libro de visitas visible dentro del sandbox (solo lectura, ambos idiomas)
    '-v', `${GUESTBOOK_FILE}:/home/visitante/libro-visitas.txt:ro`,
    '-v', `${GUESTBOOK_FILE}:/home/visitante/english/guestbook.txt:ro`,
    IMAGE,
  ];

  let term;
  try {
    term = pty.spawn('docker', dockerArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
  } catch (err) {
    // Si el spawn falla (docker ocupado, límite de procesos...), esta sesión
    // se descarta con un aviso — nunca debe tumbar el servidor entero.
    console.error(`[!] No se pudo lanzar el sandbox ${containerName}: ${err.message}`);
    logEvent('spawn_error', { ip, session: containerName, error: err.message });
    activeSessions--;
    const n = (sessionsByIp.get(ip) || 1) - 1;
    if (n <= 0) sessionsByIp.delete(ip); else sessionsByIp.set(ip, n);
    activeContainers.delete(containerName);
    try { ws.send('\r\n\x1b[31mNo se pudo iniciar el sandbox. Intenta de nuevo en un momento.\x1b[0m\r\n'); } catch (_) {}
    try { ws.close(); } catch (_) {}
    return;
  }

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    activeSessions--;
    console.log(`[-] Desconectado ${ip} -> ${containerName} (Activos: ${activeSessions}/${MAX_SESSIONS})`);
    logEvent('session_end', { ip, session: containerName });
    const n = (sessionsByIp.get(ip) || 1) - 1;
    if (n <= 0) sessionsByIp.delete(ip); else sessionsByIp.set(ip, n);
    clearTimeout(hardTimer);
    clearTimeout(idleTimer);
    try { term.kill(); } catch (_) {}
    // Por si el contenedor quedara vivo:
    activeContainers.delete(containerName);
    exec(`docker rm -f ${containerName}`, () => {});
    try { ws.close(); } catch (_) {}
  };

  // Timeout absoluto de sesión
  const hardTimer = setTimeout(() => {
    try { ws.send('\r\n\x1b[33mSesión finalizada (límite de 10 minutos).\x1b[0m\r\n'); } catch (_) {}
    cleanup();
  }, SESSION_TIMEOUT_MS);

  // Timeout por inactividad
  let idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
  function onIdle() {
    try { ws.send('\r\n\x1b[33mSesión cerrada por inactividad.\x1b[0m\r\n'); } catch (_) {}
    cleanup();
  }
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
  }

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(() => {
    try { ws.send('\r\n\x1b[90mConexión terminada. Pulsa "Nueva sesión" para volver a entrar.\x1b[0m\r\n'); } catch (_) {}
    cleanup();
  });

  // ---- Libro de visitas: firmas de esta sesión ----
  let signedThisSession = false;
  function handleGuestbook(cmdline) {
    const m = cmdline.match(/^\s*(firmar|sign)(?:\s+(.*))?$/i);
    if (!m) return;
    const M = GB_MSG[lang] || GB_MSG.es;
    const msg = sanitizeSignature((m[2] || '').replace(/^["']+|["']+$/g, ''));
    if (!msg) { notify(ws, M.usage); return; }
    if (msg.length > GB_MAX_LEN) { notify(ws, M.tooLong); return; }
    if (signedThisSession) { notify(ws, M.already); return; }
    const key = `${ip}:${new Date().toISOString().slice(0, 10)}`;
    if ((signaturesByIpDay.get(key) || 0) >= GB_PER_IP_DAY) { notify(ws, M.limit); return; }
    if (signaturesByIpDay.size > 500) signaturesByIpDay.clear(); // poda simple
    signaturesByIpDay.set(key, (signaturesByIpDay.get(key) || 0) + 1);
    signedThisSession = true;
    addSignature({ ts: new Date().toISOString(), ip, lang, msg });
    logEvent('signature', { ip, session: containerName, lang, msg });
    console.log(`[${ip}] Firmó: ${msg}`);
    notify(ws, M.thanks);
  }

  // ---- Captura de comandos (logger tipo honeypot) ----
  let cmdBuffer = '';
  // Estados del parser: 'normal' | 'esc' (tras \x1b) | 'csi' (\x1b[...) | 'osc' (\x1b]...)
  let escState = 'normal';

  function feedLogger(text) {
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (escState === 'esc') {
        if (char === '[') escState = 'csi';
        else if (char === ']') escState = 'osc';
        else escState = 'normal'; // secuencia de un solo carácter (ESC O, ESC c...)
        continue;
      }
      if (escState === 'csi') {
        // La secuencia CSI termina con un carácter entre @ y ~
        if (char >= '@' && char <= '~') escState = 'normal';
        continue;
      }
      if (escState === 'osc') {
        if (char === '\x07' || char === '\x1b') escState = 'normal';
        continue;
      }
      if (char === '\x1b') {
        escState = 'esc';
      } else if (char === '\r' || char === '\n') {
        if (cmdBuffer.length > 0) {
          console.log(`[${ip}] Ejecutó: ${cmdBuffer}`);
          logEvent('command', { ip, session: containerName, cmd: cmdBuffer });
          handleGuestbook(cmdBuffer);
          cmdBuffer = '';
        }
      } else if (char === '\x7F' || char === '\b') {
        cmdBuffer = cmdBuffer.slice(0, -1);
      } else if (char >= ' ' && char <= '~') {
        cmdBuffer += char;
      }
    }
  }

  ws.on('message', (msg) => {
    let parsed = null;
    const text = msg.toString();
    if (text.startsWith('{')) {
      try { parsed = JSON.parse(text); } catch (_) {}
    }
    if (parsed && parsed.type === 'resize') {
      const cols = Math.min(Math.max(parseInt(parsed.cols, 10) || 80, 20), 200);
      const rows = Math.min(Math.max(parseInt(parsed.rows, 10) || 24, 5), 60);
      try { term.resize(cols, rows); } catch (_) {}
      return;
    }
    // Limitar tamaño de entrada (evita pegar megabytes)
    if (text.length <= 1024) {
      resetIdle();
      term.write(text);
      feedLogger(text);
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// ---------- Apagado limpio: no dejar contenedores huérfanos ----------
function shutdown(signal) {
  console.log(`[*] Recibido ${signal}, cerrando...`);
  const names = [...activeContainers];
  const done = () => process.exit(0);
  if (names.length === 0) return done();
  exec(`docker rm -f ${names.join(' ')}`, done);
  setTimeout(done, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  console.log(`Portafolio escuchando en http://localhost:${PORT}`);
  console.log(`Imagen sandbox: ${IMAGE}`);
  console.log(`Log de sesiones: ${LOG_FILE}`);
});
