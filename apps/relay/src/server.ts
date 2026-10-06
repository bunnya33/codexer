import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { MAX_MESSAGE_BYTES } from "../../../packages/protocol/src/index.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerCommandsRoutes } from "./commands/routes.js";
import { createRelayContext } from "./core/context.js";
import type { RelayOptions } from "./core/context.js";
import { registerCoreHealth } from "./core/health.js";
import { registerHttp } from "./core/http.js";
import { registerLifecycle } from "./core/lifecycle.js";
import { registerDevicesRoutes } from "./devices/routes.js";
import { registerHistoryRoutes } from "./history/routes.js";
import { registerImagesRoutes } from "./images/routes.js";
import { registerFilesRoutes } from "./files/routes.js";
import { registerSyncClientSocket } from "./sync/client-socket.js";
import { registerSyncDeviceSocket } from "./sync/device-socket.js";
import { registerSyncRoutes } from "./sync/routes.js";
import { registerUpdatesRoutes } from "./updates/routes.js";
import { registerWeixinRoutes } from "./weixin/routes.js";
import { createWeixinService } from "./weixin/setup.js";
import { registerMetricsRoutes } from "./observability/routes.js";

/** 服务组装入口；接口、业务逻辑和存储实现分别由功能目录维护。 */
export async function createRelay(options: RelayOptions) {
  const app = Fastify({ logger: false, bodyLimit: MAX_MESSAGE_BYTES });
  await app.register(websocket, {
    options: { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false },
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  const context = createRelayContext(options);
  context.weixin = createWeixinService(context);
  await registerHttp(app, context);
  registerMetricsRoutes(app, context);

  registerCoreHealth(app, context);
  registerAuthRoutes(app, context);
  registerAdminRoutes(app, context);
  registerDevicesRoutes(app, context);
  registerSyncRoutes(app, context);
  registerCommandsRoutes(app, context);
  registerHistoryRoutes(app, context);
  registerImagesRoutes(app, context);
  registerFilesRoutes(app, context);
  registerWeixinRoutes(app, context);
  registerUpdatesRoutes(app, context);
  registerSyncDeviceSocket(app, context);
  registerSyncClientSocket(app, context);
  registerLifecycle(app, context);

  if (context.weixin) app.addHook("onReady", async () => context.weixin!.start());
  return app;
}
