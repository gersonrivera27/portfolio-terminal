# Threat Detection Honeypot & SOC Lab

Status: Completed

I wanted to learn detection and response on real adversary traffic
instead of lab data, so I decided to stand up a full SOC loop:
collecting, triaging and understanding real attacks end to end.

The result was a Cowrie honeypot that fed a Grafana and Loki stack
with automated daily reports, where captured attacks were enriched with
OSINT and mapped to MITRE ATT&CK.

Technologies: Cowrie, Grafana, Loki, UFW, Tailscale, MITRE ATT&CK, Linux
