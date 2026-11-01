# Alternativa con Docker: docker compose up -d
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data TZ=Europe/Madrid
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.js"]
