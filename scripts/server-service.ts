export const SERVICE_NAME = "codexer-relay.service";
export const SERVICE_MARKER = "# Managed by Codexer installer";

export function serviceUnit(node: string): string {
  if (!node.startsWith("/") || /\s/.test(node)) throw new Error("invalid-node-path");
  return `${SERVICE_MARKER}
[Unit]
Description=Codexer Relay and Web
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=codexer
Group=codexer
WorkingDirectory=/opt/codexer/current
EnvironmentFile=/etc/codexer/relay.env
Environment=NODE_ENV=production
ExecStart=${node} /opt/codexer/current/dist/apps/relay/src/main.js
StateDirectory=codexer
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/codexer /var/lib/codexer-updater/inbox

[Install]
WantedBy=multi-user.target
`;
}

export function isManagedUnit(content: string): boolean {
  return content.startsWith(SERVICE_MARKER) && content.includes("WorkingDirectory=/opt/codexer/current\n");
}
