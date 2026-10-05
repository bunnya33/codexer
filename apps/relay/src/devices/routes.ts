import { HttpError } from "../core/errors.js";
import { bearer } from "../auth/guards.js";
import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 设备归属、在线状态与撤销。 */
export function registerDevicesRoutes(app: FastifyInstance, context: RelayContext): void {
  const store = context.store;
  const queue = context.queue;
  const agents = context.connections.agents;
  const broadcast = context.connections.broadcast;
  const failHistory = context.connections.failRequests;

  const principals = context.guards.principals;
  const control = context.guards.control;
  const deviceAccess = context.guards.deviceAccess;

  app.get("/v1/devices", { preHandler: control }, async (request) => {
    const principal = principals.get(request)!;
    return {
      devices: (await store.listDevices(principal)).map((device) => ({
        ...device,
        online: agents.has(String(device.id)),
      })),
    };
  });

  app.delete<{ Params: { deviceId: string } }>(
    "/v1/devices/:deviceId",
    { preHandler: deviceAccess },
    async (request) =>
      queue.runDevice(request.params.deviceId, async () => {
        if (!(await store.ownsDevice(request.params.deviceId, principals.get(request)!)))
          throw new HttpError(404, "device-not-found");
        if (!(await store.revoke(request.params.deviceId)))
          throw new HttpError(404, "device-not-found");
        agents.get(request.params.deviceId)?.socket.close(4003, "revoked");
        agents.delete(request.params.deviceId);
        failHistory(request.params.deviceId, 404, "device-revoked");
        broadcast(request.params.deviceId, {
          type: "device.presence",
          deviceId: request.params.deviceId,
          online: false,
        });
        return { revoked: true };
      }),
  );

  app.get<{ Params: { deviceId: string } }>(
    "/v1/agent/:deviceId/session",
    {
      preHandler: async (request) => {
        if (!(await store.authorizeDevice(request.params.deviceId, bearer(request))))
          throw new HttpError(401, "unauthorized");
      },
    },
    async () => ({ active: true }),
  );
}
