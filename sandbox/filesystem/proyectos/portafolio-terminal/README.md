# Portafolio con terminal enjaulada (este sitio)

Qué es:
  Una página web servida desde mi Raspberry Pi donde cada
  visitante obtiene una terminal bash real, aislada en un
  contenedor Docker desechable.

Tecnologías:
  - Raspberry Pi + Raspberry Pi OS
  - Node.js (Express, WebSocket, node-pty)
  - Docker (aislamiento: sin red, solo lectura, límites de recursos)
  - xterm.js en el navegador
  - Cloudflare Tunnel (exposición segura sin abrir puertos)

Qué aprendí:
  - Aislamiento y seguridad de contenedores
  - Comunicación en tiempo real con WebSockets
  - Administración de un servidor Linux 24/7
