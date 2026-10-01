FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
COPY tsconfig.json tsconfig.server.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev --workspaces=false

FROM node:24-bookworm-slim
ENV NODE_ENV=production RELAY_HOST=0.0.0.0 RELAY_PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/apps/web/dist ./web
COPY --from=build --chown=node:node /app/apps/admin/dist ./admin
COPY --from=build --chown=node:node /app/package.json ./package.json
ENV RELAY_WEB_DIR=/app/web RELAY_ADMIN_DIR=/app/admin
USER node
EXPOSE 8787
CMD ["node", "dist/apps/relay/src/main.js"]
