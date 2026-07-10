# Portafolio con Terminal Real Enjaulada 🖥️

Portafolio web servido desde tu Raspberry Pi, expuesto a internet con Cloudflare Tunnel. Los visitantes usan una **terminal real** (bash) pero cada sesión corre dentro de un contenedor Docker desechable, sin red, con sistema de archivos de solo lectura y límites de CPU/RAM. No pueden tocar tu Pi.

## Arquitectura

```
Visitante ──HTTPS──> Cloudflare Tunnel ──> Raspberry Pi
                                            └─ Node.js (Express + WebSocket, puerto 3000)
                                                └─ por cada sesión: docker run (sandbox)
                                                    - sin red (--network none)
                                                    - solo lectura (--read-only)
                                                    - 64 MB RAM, 0.5 CPU, 50 procesos máx
                                                    - usuario sin privilegios
                                                    - se autodestruye al cerrar o a los 10 min
```

## Capas de seguridad

1. **Aislamiento Docker**: el visitante nunca ejecuta nada en tu Pi directamente; todo pasa dentro de un contenedor efímero.
2. **Sin red en el contenedor**: no pueden hacer curl/wget ni atacar tu red local.
3. **Sistema de archivos de solo lectura**: no pueden modificar nada (solo /tmp escribible, limitado a 8 MB).
4. **Límites de recursos**: RAM, CPU y número de procesos acotados (evita fork bombs).
5. **Timeout**: cada sesión muere a los 10 minutos; máximo 5 sesiones simultáneas y 2 por IP.
6. **Cloudflare delante**: tu IP queda oculta, sin puertos abiertos en tu router, y puedes activar rate limiting/WAF gratis.
7. **Headers de proxy solo confiables desde localhost**: `cf-connecting-ip` / `x-forwarded-for` solo se aceptan si la conexión viene del tunnel (loopback); si alguien llega directo al puerto 3000 no puede falsificar su IP para saltarse el límite por IP.
8. **Sin contenedores huérfanos**: los sandboxes van etiquetados; al arrancar el servidor limpia los que quedaron de un crash, y en `SIGTERM`/`SIGINT` mata los activos antes de salir.

## Log de sesiones (honeypot-style)

Cada sesión y cada comando ejecutado por un visitante se registra en `server/logs/sessions.jsonl` como JSON por línea (`ts`, `event`, `ip`, `session`, `cmd`, `lang`), filtrando las secuencias de escape del teclado (flechas, etc.).

## Observabilidad (Grafana + Loki + Promtail)

En `observability/` hay un stack completo dimensionado para la Pi (retención de
30 días, Loki sin puerto expuesto, Grafana en el 3001):

```bash
cd observability
# cambia GF_SECURITY_ADMIN_PASSWORD en docker-compose.yml primero
docker compose up -d
# Grafana: http://IP-DE-LA-PI:3001 (datasource Loki ya provisionado)
```

Consultas LogQL útiles (Explore → Loki):

```logql
{job="portfolio-terminal"}                                  # todo
{job="portfolio-terminal", event="command"} | json | line_format "{{.ip}} $ {{.cmd}}"
sum by (lang) (count_over_time({job="portfolio-terminal", event="session_start"}[1d]))
```

## Estructura del proyecto

```
portfolio-terminal/
├── README.md              ← esta guía
├── server/
│   ├── server.js          ← backend Node.js
│   ├── package.json
│   └── logs/              ← sessions.jsonl (generado, no se versiona)
├── public/
│   ├── index.html         ← portafolio + terminal
│   └── vendor/            ← xterm.js auto-hospedado (sin depender de CDN)
└── sandbox/
    ├── Dockerfile         ← imagen del sandbox
    └── filesystem/        ← lo que verá el visitante (edítalo con TU contenido)
        ├── bienvenida.txt
        ├── sobre-mi.txt
        ├── habilidades.txt
        ├── contacto.txt
        ├── proyectos/
        │   ├── honeypot-soc/README.txt
        │   ├── stackpos/README.txt
        │   ├── network-segmentation/README.txt
        │   └── network-forensics/README.txt
        └── english/       ← todo el contenido traducido al inglés
            ├── welcome.txt
            ├── about-me.txt
            ├── skills.txt
            ├── contact.txt
            └── projects/…

## Sandbox bilingüe

El idioma elegido en la web (ES/EN/PT) viaja por el WebSocket (`/terminal?lang=xx`),
el servidor lo valida y lo inyecta al contenedor como `VISITOR_LANG`. El script de
perfil de la imagen arranca la sesión en `~/english` con bienvenida en inglés para
`en`/`pt`, y en `~` con la bienvenida en español para el resto. Tras editar el
contenido o el Dockerfile hay que reconstruir la imagen:

```bash
cd sandbox && docker build -t portfolio-sandbox .
```
```

## Instalación en la Raspberry Pi

### 1. Requisitos

```bash
sudo apt update && sudo apt upgrade -y
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git build-essential python3
# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # cierra sesión y vuelve a entrar
```

### 2. Copiar el proyecto y construir el sandbox

```bash
# copia la carpeta portfolio-terminal a la Pi (scp, git, USB...)
cd portfolio-terminal/sandbox
docker build -t portfolio-sandbox .
```

Prueba el sandbox manualmente:

```bash
docker run -it --rm --network none --read-only portfolio-sandbox
# dentro: ls, cat bienvenida.txt, exit
```

### 3. Instalar y arrancar el servidor

```bash
cd ../server
npm install
node server.js
# abre http://IP-DE-LA-PI:3000 desde otra máquina de tu red para probar
```

### 4. Dejarlo corriendo siempre (systemd)

Crea `/etc/systemd/system/portfolio.service`:

```ini
[Unit]
Description=Portafolio con terminal
After=network.target docker.service
Requires=docker.service

[Service]
User=pi
WorkingDirectory=/home/pi/portfolio-terminal/server
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now portfolio
```

### 5. Exponerlo con Cloudflare Tunnel

Necesitas un dominio en Cloudflare (uno barato o gratis con DNS en Cloudflare).

```bash
# instalar cloudflared (ARM64)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared
sudo mv cloudflared /usr/local/bin/ && sudo chmod +x /usr/local/bin/cloudflared

cloudflared tunnel login
cloudflared tunnel create portfolio
cloudflared tunnel route dns portfolio portafolio.tudominio.com
```

Crea `~/.cloudflared/config.yml`:

```yaml
tunnel: portfolio
credentials-file: /home/pi/.cloudflared/<ID-DEL-TUNEL>.json
ingress:
  - hostname: portafolio.tudominio.com
    service: http://localhost:3000
  - service: http_status:404
```

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Listo: `https://portafolio.tudominio.com` funciona desde cualquier lugar, sin abrir puertos.

### 6. Recomendado en el panel de Cloudflare

- Security → WAF: regla de rate limiting sobre tu hostname.
- Bots → activar "Bot Fight Mode".
- SSL/TLS → modo "Full".

## Personalizar tu contenido

Edita los archivos de `sandbox/filesystem/` con tus proyectos reales y reconstruye:

```bash
cd sandbox && docker build -t portfolio-sandbox .
```

También edita `public/index.html` (nombre, enlaces, colores).

## Comandos disponibles para el visitante

Todo lo que trae la imagen Alpine: `ls`, `cd`, `cat`, `less`, `tree`, `grep`, `find`, `echo`, `whoami`... Si quieren romper algo, solo rompen su propio contenedor desechable.
