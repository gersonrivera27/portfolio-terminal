# Threat Detection Honeypot & SOC Lab (Live)

Estado: En curso

Quería aprender detección y respuesta sobre tráfico real de adversarios en 
lugar de datos de laboratorio, así que decidí levantar un ciclo completo de SOC: 
recolectando, clasificando y entendiendo ataques reales de principio a fin.

El resultado es un honeypot Cowrie en vivo alimentando un stack de Grafana 
y Loki con reportes diarios automatizados, donde los ataques capturados se 
enriquecen con OSINT y se mapean a MITRE ATT&CK.

Tecnologías: Cowrie, Grafana, Loki, UFW, Tailscale, MITRE ATT&CK, Linux
