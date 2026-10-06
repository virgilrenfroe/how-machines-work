FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
# Root html and js are the lessons. A new exhibit is picked up without another COPY line.
COPY *.html *.js README.md .nojekyll /srv/
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
