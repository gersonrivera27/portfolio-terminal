# Sandbox del portafolio: imagen mínima con herramientas de exploración.
FROM alpine:3.20

RUN apk add --no-cache bash tree less nano \
    && adduser -D -s /bin/bash visitante

# Contenido del portafolio (solo lectura para el visitante)
COPY --chown=root:root filesystem/ /home/visitante/
RUN chmod -R a+rX /home/visitante

# Mensaje de bienvenida y prompt bonito.
# VISITOR_LANG llega desde el servidor (idioma elegido en la web):
# en/pt arrancan en ~/english con la bienvenida en inglés.
RUN printf '%s\n' \
    'export PS1="\[\e[32m\]visitante@raspberry-pi\[\e[0m\]:\[\e[34m\]\w\[\e[0m\]\$ "' \
    'case "$VISITOR_LANG" in' \
    '  en|pt) cd "$HOME/english" && cat welcome.txt 2>/dev/null ;;' \
    '  *) cat "$HOME/bienvenida.txt" 2>/dev/null ;;' \
    'esac' \
    > /etc/profile.d/prompt.sh

USER visitante
WORKDIR /home/visitante
ENV HOME=/home/visitante ENV=/etc/profile.d/prompt.sh

CMD ["/bin/bash", "--login"]
