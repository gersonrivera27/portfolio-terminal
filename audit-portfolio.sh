#!/usr/bin/env bash
# ============================================================
#  audit-portfolio.sh  —  SOLO LECTURA
#  No modifica ningún fichero, no reinicia servicios, no toca
#  contenedores. Solo lee y escribe un informe en /tmp.
#
#  Uso:   sudo bash audit-portfolio.sh
#  Salida: /tmp/portfolio-audit.txt
# ============================================================

set -uo pipefail

APP=/opt/portfolio-terminal
SRV=$APP/server
OUT=/tmp/portfolio-audit.txt
: > "$OUT"

sec() { printf '\n\n===== %s =====\n' "$1" >> "$OUT"; }
note() { printf -- '--- %s\n' "$1" >> "$OUT"; }

# ------------------------------------------------------------
sec "1. UNIDAD SYSTEMD"
note "fichero de unidad"
cat /etc/systemd/system/portfolio-terminal.service >> "$OUT" 2>&1

note "propiedades efectivas"
systemctl show portfolio-terminal \
  -p User -p Group -p SupplementaryGroups -p Environment \
  -p ProtectSystem -p ProtectHome -p PrivateTmp -p ReadWritePaths \
  -p NoNewPrivileges -p Restart -p StartLimitBurst -p MainPID >> "$OUT" 2>&1

# ------------------------------------------------------------
sec "2. ENTORNO REAL DEL PROCESO"
PID=$(systemctl show -p MainPID --value portfolio-terminal 2>/dev/null)
note "MainPID=$PID"
if [ -n "$PID" ] && [ "$PID" != "0" ] && [ -r "/proc/$PID/environ" ]; then
  tr '\0' '\n' < "/proc/$PID/environ" \
    | grep -iE '^(HOME|DOCKER_CONFIG|PATH|NODE_ENV|USER)=' >> "$OUT" 2>&1
else
  echo "(no legible)" >> "$OUT"
fi

# ------------------------------------------------------------
sec "3. LANZAMIENTO DEL SANDBOX  <-- flags de seguridad"
note "invocaciones de docker / spawn / exec"
grep -nE "docker|spawn|execFile|exec\(|Dockerode|dockerode" "$SRV/server.js" >> "$OUT" 2>&1

note "flags presentes o ausentes"
for f in "--network" "--read-only" "--user" "--memory" "--cpus" \
         "--pids-limit" "--cap-drop" "--security-opt" "--rm" "--tmpfs" "--ulimit"; do
  if grep -qF -- "$f" "$SRV/server.js" 2>/dev/null; then
    printf 'PRESENTE  %-16s -> %s\n' "$f" "$(grep -nF -- "$f" "$SRV/server.js" | head -3 | tr '\n' ' ')" >> "$OUT"
  else
    printf 'AUSENTE   %s\n' "$f" >> "$OUT"
  fi
done

note "bloque completo donde se construyen los argumentos (30 lineas de contexto)"
grep -n -A30 -m2 -E "['\"]run['\"]|docker run|args\s*=\s*\[" "$SRV/server.js" >> "$OUT" 2>&1

note "el entorno se hereda al hijo?  (buscar env:)"
grep -n -B3 -A6 "env:" "$SRV/server.js" >> "$OUT" 2>&1

# ------------------------------------------------------------
sec "4. IP DEL CLIENTE"
grep -nE "remoteAddress|x-forwarded-for|cf-connecting-ip|headers\[" "$SRV/server.js" >> "$OUT" 2>&1

# ------------------------------------------------------------
sec "5. GUESTBOOK: ESCRITURA Y VALIDACION"
grep -niE "guestbook|libro-visitas|firmar|sign|appendFile|writeFile" "$SRV/server.js" >> "$OUT" 2>&1

note "limites de longitud / saneado"
grep -nE "slice\(|substring\(|\.length\s*[<>]|maxLength|escape|sanitiz|replace\(/" "$SRV/server.js" >> "$OUT" 2>&1

# ------------------------------------------------------------
sec "6. RENDERIZADO EN EL FRONTEND (riesgo XSS)"
note "innerHTML  <-- peligroso si recibe entrada del usuario"
grep -rn "innerHTML" "$APP/public" >> "$OUT" 2>&1
note "textContent / innerText  <-- seguro"
grep -rnc "textContent\|innerText" "$APP/public" >> "$OUT" 2>&1
note "libreria de terminal usada"
grep -rniE "xterm|term\.write|new Terminal" "$APP/public" 2>/dev/null | head -20 >> "$OUT" 2>&1

# ------------------------------------------------------------
sec "7. LIMITES DE ENTRADA Y CONCURRENCIA"
grep -nE "maxPayload|MAX_|LIMIT|limit|rate|throttle|10\b.*activ|activos|Activos" "$SRV/server.js" >> "$OUT" 2>&1
note "timeout de sesion"
grep -nE "setTimeout|TIMEOUT|600000|10\s*\*\s*60" "$SRV/server.js" >> "$OUT" 2>&1

# ------------------------------------------------------------
sec "8. DOCKERFILE DEL SANDBOX"
find "$APP" -name 'Dockerfile*' -not -path '*/node_modules/*' 2>/dev/null | while read -r d; do
  note "$d"
  cat "$d" >> "$OUT" 2>&1
done

note "binarios SUID dentro de la imagen"
docker run --rm --network none --entrypoint sh portfolio-sandbox \
  -c 'find / -perm -4000 -type f 2>/dev/null | head -20' >> "$OUT" 2>&1

note "binarios de red presentes"
docker run --rm --network none --entrypoint sh portfolio-sandbox \
  -c 'for b in curl wget nc ssh python3 perl gcc apk; do command -v $b; done' >> "$OUT" 2>&1

# ------------------------------------------------------------
sec "9. PERMISOS"
ls -ld "$APP" "$SRV" "$SRV/data" "$SRV/logs" >> "$OUT" 2>&1
id termsvc >> "$OUT" 2>&1

# ------------------------------------------------------------
sec "10. CONTENEDOR EN VIVO (abre la web antes de correr esto)"
CID=$(docker ps -q --filter "name=sandbox" | head -1)
if [ -n "$CID" ]; then
  docker inspect "$CID" --format '
NetworkMode:    {{.HostConfig.NetworkMode}}
ReadonlyRootfs: {{.HostConfig.ReadonlyRootfs}}
User:           {{.Config.User}}
CapDrop:        {{.HostConfig.CapDrop}}
CapAdd:         {{.HostConfig.CapAdd}}
Privileged:     {{.HostConfig.Privileged}}
SecurityOpt:    {{.HostConfig.SecurityOpt}}
PidsLimit:      {{.HostConfig.PidsLimit}}
Memory:         {{.HostConfig.Memory}}
NanoCpus:       {{.HostConfig.NanoCpus}}
Binds:          {{.HostConfig.Binds}}
AutoRemove:     {{.HostConfig.AutoRemove}}
Tmpfs:          {{.HostConfig.Tmpfs}}' >> "$OUT" 2>&1
else
  echo "SIN SESION ACTIVA - abre portfolio.gerson-sec.com y vuelve a correr el script" >> "$OUT"
fi

# ------------------------------------------------------------
sec "11. VOLUMEN DE LOGS"
wc -l "$SRV/logs/"*.jsonl >> "$OUT" 2>&1
df -h / | tail -1 >> "$OUT" 2>&1

# ------------------------------------------------------------
# Enmascarado de posibles secretos antes de compartir
sed -i -E 's/(TOKEN|SECRET|KEY|PASSWORD|PASS|API[_-]?KEY)=[^ ]*/\1=***REDACTADO***/Ig' "$OUT"
sed -i -E 's/eyJ[A-Za-z0-9_-]{20,}/***JWT-REDACTADO***/g' "$OUT"

echo
echo "Informe: $OUT   ($(wc -l < "$OUT") lineas)"
echo "REVISALO antes de compartirlo por si quedó algún dato sensible."
