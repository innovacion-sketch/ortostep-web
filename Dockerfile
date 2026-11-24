# Página ORTOSTEP: sitio estático servido con nginx (para Easypanel u otro servidor con Docker).
# En Easypanel: App desde GitHub, ruta de construcción "/", Dockerfile "Dockerfile", puerto 80.
FROM nginx:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html aviso-privacidad.html terminos.html /usr/share/nginx/html/
COPY assets /usr/share/nginx/html/assets
COPY videos /usr/share/nginx/html/videos

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/salud >/dev/null || exit 1
