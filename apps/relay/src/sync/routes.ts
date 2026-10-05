import { HttpError } from "../core/errors.js";
import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 设备同步；同一队列保证重放与实时事件的顺序。 */
export function registerSyncRoutes(app: FastifyInstance, context: RelayContext): void {
  const store = context.store;
  const agents = context.connections.agents;
  const deviceAccess = context.guards.deviceAccess;

  app.get<{ Params: { deviceId: string } }>(
    "/v1/devices/:deviceId/snapshot",
    { preHandler: deviceAccess },
    async (request) => {
      const snapshot = await store.snapshot(request.params.deviceId);
      if (!snapshot) throw new HttpError(404, "snapshot-not-found");
      return { online: agents.has(request.params.deviceId), snapshot };
    },
  );

  app.get<{ Params: { deviceId: string } }>(
    "/v1/devices/:deviceId/catalog",
    { preHandler: deviceAccess },
    async (request) => {
      const catalog = await store.catalog(request.params.deviceId);
      if (!catalog) throw new HttpError(404, "catalog-not-ready");
      return { catalog };
    },
  );
}
