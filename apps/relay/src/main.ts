import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { bootstrapAdmin, adminAccountPath } from "../../../packages/shared/src/admin-account.js";
import { createRelay } from "./server.js";
import { RelayStore } from "./storage/store.js";
import { ServerUpdates } from "./updates/service.js";
import { loadWeixinKey } from "./weixin/secrets.js";
import { WeixinApi } from "./weixin/api.js";

const directory = resolve(process.env.RELAY_DATA_DIR ?? ".local/relay");
const adminPath = adminAccountPath();
const store = await RelayStore.open(process.env.DATABASE_URL, directory);
await bootstrapAdmin(store, adminPath);
const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
  version: string;
};
const updates = new ServerUpdates(version, "/var/lib/codexer-updater/inbox");
const weixin =
  process.env.RELAY_WEIXIN_ENABLED === "false"
    ? undefined
    : {
        key: await loadWeixinKey(directory, process.env.RELAY_WEIXIN_KEY),
        api: new WeixinApi(version),
      };
const app = await createRelay({
  store,
  updates,
  version,
  weixin,
  allowedOrigins: (process.env.RELAY_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
  webRoot: resolve(process.env.RELAY_WEB_DIR ?? "apps/web/dist"),
  adminRoot: resolve(process.env.RELAY_ADMIN_DIR ?? "apps/admin/dist"),
});
updates.start();
app.addHook("onClose", async () => updates.close());
const bindHost = process.env.RELAY_HOST ?? "127.0.0.1";
const address = await app.listen({
  host: bindHost,
  port: Number(process.env.RELAY_PORT ?? "8787"),
});
console.log(
  JSON.stringify({
    type: "relay.started",
    address,
    bindHost,
    database: process.env.DATABASE_URL ? "postgresql" : "embedded-postgresql",
    adminCredentialFile: adminPath,
  }),
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (!stopping) {
      stopping = true;
      void app.close();
    }
  });
