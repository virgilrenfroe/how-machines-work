FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
# Every lesson page and script. An explicit file list has shipped exhibits Caddy then missed.
COPY *.html *.js README.md .nojekyll /srv/
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
