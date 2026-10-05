import { RelayScheduler } from "../concurrency/scheduler.js";
import { createGuards } from "../auth/guards.js";
import { createLoginService } from "../auth/service.js";
import { createCommandService } from "../commands/service.js";
import type { RelayStore } from "../storage/store.js";
import { createConnections } from "../transport/connections.js";
import type { ServerUpdates } from "../updates/service.js";
import type { WeixinOptions, WeixinService } from "../weixin/service.js";

export type RelayOptions = {
  store: RelayStore;
  allowedOrigins?: string[];
  heartbeatMs?: number;
  cleanupMs?: number;
  cleanupRetryMs?: number;
  webRoot?: string;
  adminRoot?: string;
  updates?: ServerUpdates;
  version?: string;
  weixin?: WeixinOptions;
};

/** 显式传递共享依赖，功能模块不自行创建数据库或全局连接表。 */
export type RelayContext = ReturnType<typeof createRelayContext>;

export function createRelayContext(options: RelayOptions) {
  const metrics = options.store.metrics;
  const connections = createConnections(metrics);

  return {
    options,
    store: options.store,
    metrics,
    queue: new RelayScheduler(metrics),
    connections,
    guards: createGuards(options.store, options.allowedOrigins ?? []),
    login: createLoginService(options.store),
    commands: createCommandService(options.store, connections),
    weixin: undefined as WeixinService | undefined,
    closing: false,
  };
}
