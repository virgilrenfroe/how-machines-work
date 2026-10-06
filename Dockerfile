FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
# Root html and js are the lessons. A new exhibit is picked up without another COPY line.
# og.png is the Pages share card (absolute URL in the hub meta).
COPY *.html *.js README.md .nojekyll og.png /srv/
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
