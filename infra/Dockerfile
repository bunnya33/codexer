FROM node:24-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/control-desktop/package.json ./apps/control-desktop/package.json
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --ignore-scripts
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm run build:protocol && npm run build:web && npm run build:admin
RUN mkdir -p apps/relay/assets/web apps/relay/assets/admin && cp -a apps/web/dist/. apps/relay/assets/web/ && cp -a apps/admin/dist/. apps/relay/assets/admin/

FROM golang:1.27-bookworm AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY apps/relay ./apps/relay
COPY cmd ./cmd
COPY internal ./internal
COPY --from=frontend /app/apps/relay/assets ./apps/relay/assets
COPY --from=frontend /app/apps/relay/protocol/schemas.json ./apps/relay/protocol/schemas.json
RUN mkdir -p /data && chmod 700 /data
ARG VERSION=0.3.0
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /codexer ./cmd/codexer

FROM gcr.io/distroless/static-debian12:nonroot
ENV RELAY_HOST=0.0.0.0 RELAY_PORT=8787 RELAY_DATA_DIR=/var/lib/codexer RELAY_ADMIN_FILE=/var/lib/codexer/admin-account.secret
WORKDIR /app
COPY --from=build /codexer /app/codexer
COPY --from=build --chown=65532:65532 /data /var/lib/codexer
USER 65532:65532
EXPOSE 8787
ENTRYPOINT ["/app/codexer"]
CMD ["serve"]
