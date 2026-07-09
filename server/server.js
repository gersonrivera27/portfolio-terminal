// Servidor del portafolio con terminal real enjaulada en Docker.
// Cada sesión WebSocket lanza un contenedor efímero, aislado y con límites.

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

// ---------- Configuración ----------
const PORT = process.env.PORT || 3000;
const IMAGE = process.env.SANDBOX_IMAGE || 'portfolio-sandbox';
const MAX_SESSIONS = 5;          // sesiones simultáneas en total
const MAX_PER_IP = 2;            // sesiones simultáneas por IP
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos por sesión
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;     // 3 minutos sin teclear

// ---------- Servidor HTTP ----------
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
const server = http.createServer(app);

// ---------- WebSocket -> Docker ----------
const wss = new WebSocketServer({ server, path: '/terminal' });

let activeSessions = 0;
const sessionsByIp = new Map();

function clientIp(req) {
  // Detrás de Cloudflare Tunnel, la IP real llega en este header.
  return (
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);

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
  console.log(`[+] Nueva conexión desde ${ip} -> ${containerName} (Activos: ${activeSessions}/${MAX_SESSIONS})`);
  let cmdBuffer = '';

  // Contenedor desechable, sin red, solo lectura, sin privilegios, con límites.
  const dockerArgs = [
    'run', '-it', '--rm',
    '--name', containerName,
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
    IMAGE,
  ];

  const term = pty.spawn('docker', dockerArgs, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    env: process.env,
  });

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    activeSessions--;
    console.log(`[-] Desconectado ${ip} -> ${containerName} (Activos: ${activeSessions}/${MAX_SESSIONS})`);
    const n = (sessionsByIp.get(ip) || 1) - 1;
    if (n <= 0) sessionsByIp.delete(ip); else sessionsByIp.set(ip, n);
    clearTimeout(hardTimer);
    clearTimeout(idleTimer);
    try { term.kill(); } catch (_) {}
    // Por si el contenedor quedara vivo:
    require('child_process').exec(`docker rm -f ${containerName}`, () => {});
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
    try { ws.send('\r\n\x1b[90mConexión terminada. Recarga para una nueva sesión.\x1b[0m\r\n'); } catch (_) {}
    cleanup();
  });

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
      
      // Capturar comandos silenciosamente (Honeypot logger)
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '\r' || char === '\n') {
          if (cmdBuffer.length > 0) {
            console.log(`[${ip}] Ejecutó: ${cmdBuffer}`);
            cmdBuffer = '';
          }
        } else if (char === '\x7F' || char === '\b') {
          cmdBuffer = cmdBuffer.slice(0, -1);
        } else if (char >= ' ' && char <= '~') {
          cmdBuffer += char;
        }
      }
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(PORT, () => {
  console.log(`Portafolio escuchando en http://localhost:${PORT}`);
  console.log(`Imagen sandbox: ${IMAGE}`);
});
