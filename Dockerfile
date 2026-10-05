FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html four-bar.html main.js fourbar.js gears.js linkage.js README.md .nojekyll /srv/
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
