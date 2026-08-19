# Threat Detection Honeypot & SOC Lab

Estado: Finalizado

Quería aprender detección y respuesta sobre tráfico real de adversarios en 
lugar de datos de laboratorio, así que decidí levantar un ciclo completo de SOC: 
recolectando, clasificando y entendiendo ataques reales de principio a fin.

El resultado fue un honeypot Cowrie que alimentó un stack de Grafana 
y Loki con reportes diarios automatizados, donde los ataques capturados se 
enriquecieron con OSINT y se mapearon a MITRE ATT&CK.

Tecnologías: Cowrie, Grafana, Loki, UFW, Tailscale, MITRE ATT&CK, Linux
