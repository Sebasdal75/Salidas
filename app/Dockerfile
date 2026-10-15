# WMS Salidas: una imagen que corre en cualquier lado (Azure Container Apps,
# Azure App Service para contenedores, un servidor propio con Docker).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_PATH=/datos/wms.sqlite TZ=America/Mexico_City
COPY package.json ./
COPY src ./src
# La base vive en un volumen: sin él, se pierde al actualizar la imagen. La
# carpeta se crea ANTES y con dueño `node`, o el volumen nuevo nacería de root y
# la app, que corre sin privilegios, no podría escribir en él.
RUN mkdir /datos && chown node:node /datos
VOLUME ["/datos"]
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/estado || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/servidor.js"]
