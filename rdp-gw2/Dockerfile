# Garely RDP v2 tunnel (guacamole-lite). Tiny Node service.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./
EXPOSE 8080
USER node
CMD ["node", "server.js"]
