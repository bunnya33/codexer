import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 聚合指标仅供管理员读取，不包含账号、设备 ID、凭据、SQL 或消息内容。 */
export function registerMetricsRoutes(app: FastifyInstance, context: RelayContext): void {
  app.addHook("onResponse", async (_request, reply) => {
    context.metrics.observeHttp(reply.elapsedTime, reply.statusCode);
  });

  app.get("/v1/admin/metrics", { preHandler: context.guards.admin }, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return {
      ...context.metrics.snapshot(),
      scheduler: context.queue.snapshot(),
      connections: context.connections.snapshot(),
    };
  });
}
