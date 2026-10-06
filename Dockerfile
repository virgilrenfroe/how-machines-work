FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html four-bar.html lever.html pulley.html main.js fourbar.js lever.js pulley.js gears.js linkage.js levers.js pulleys.js README.md .nojekyll /srv/
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
