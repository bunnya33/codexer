import { resolve } from "node:path";
import { bootstrapAdmin, adminAccountPath } from "../../../packages/shared/src/admin-account.js";
import { createRelay } from "./server.js";
import { RelayStore } from "./store.js";

const directory = resolve(process.env.RELAY_DATA_DIR ?? ".local/relay");
const adminPath = adminAccountPath();
const store = await RelayStore.open(process.env.DATABASE_URL, directory);
await bootstrapAdmin(store, adminPath);
const app = await createRelay({ store, allowedOrigins: (process.env.RELAY_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean), webRoot: resolve(process.env.RELAY_WEB_DIR ?? "apps/web/dist"), adminRoot: resolve(process.env.RELAY_ADMIN_DIR ?? "apps/admin/dist") });
const bindHost = process.env.RELAY_HOST ?? "127.0.0.1";
const address = await app.listen({ host: bindHost, port: Number(process.env.RELAY_PORT ?? "8787") });
console.log(JSON.stringify({ type: "relay.started", address, bindHost, database: process.env.DATABASE_URL ? "postgresql" : "embedded-postgresql", adminCredentialFile: adminPath }));
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { if (!stopping) { stopping = true; void app.close(); } });
