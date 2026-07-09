# Threat Detection Honeypot & SOC Lab (Live)

Status: Ongoing

I wanted to learn detection and response on real adversary traffic
instead of lab data, so I decided to stand up a full SOC loop:
collecting, triaging and understanding real attacks end to end.

The result is a live Cowrie honeypot feeding a Grafana and Loki stack
with automated daily reports, where captured attacks are enriched with
OSINT and mapped to MITRE ATT&CK.

Technologies: Cowrie, Grafana, Loki, UFW, Tailscale, MITRE ATT&CK, Linux
