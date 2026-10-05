import { z } from "zod";
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { HistoryPage } from "../../../../packages/protocol/src/index.js";
import { HttpError } from "../core/errors.js";
import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 历史分页请求的转发、限额与超时。 */
export function registerHistoryRoutes(app: FastifyInstance, context: RelayContext): void {
  const store = context.store;
  const agents = context.connections.agents;
  const pendingHistory = context.connections.pendingHistory;
  const send = context.connections.send;
  const principals = context.guards.principals;
  const deviceAccess = context.guards.deviceAccess;

  app.get<{ Params: { deviceId: string; threadId: string }; Querystring: { cursor?: string } }>(
    "/v1/devices/:deviceId/threads/:threadId/turns",
    { preHandler: deviceAccess },
    async (request) => {
      const { deviceId, threadId } = request.params;
      // 只把校验与发送请求放进设备队列；等待 Agent 回包必须在队列外，避免死锁。
      const { response } = await context.queue.runDevice(deviceId, async () => {
        if (!(await store.ownsDevice(deviceId, principals.get(request)!)))
          throw new HttpError(404, "device-not-found");
        const { cursor } = z
          .object({ cursor: z.string().min(1).max(2048).optional() })
          .parse(request.query);
        const catalog = await store.catalog(deviceId);
        if (!catalog?.threads.some((thread) => thread.id === threadId))
          throw new HttpError(404, "thread-not-in-catalog");
        const agent = agents.get(deviceId);
        if (!agent || agent.socket.readyState !== WebSocket.OPEN)
          throw new HttpError(409, "device-offline");
        if (
          pendingHistory.size >= 20 ||
          [...pendingHistory.values()].filter((value) => value.deviceId === deviceId).length >= 4
        )
          throw new HttpError(429, "history-busy");
        const requestId = randomUUID();
        return {
          response: new Promise<HistoryPage>((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingHistory.delete(requestId);
              reject(new HttpError(504, "history-timeout"));
            }, 30000);
            pendingHistory.set(requestId, { deviceId, threadId, resolve, reject, timer });
            if (
              !send(agent.socket, {
                type: "history.request",
                requestId,
                threadId,
                cursor: cursor ?? null,
              })
            ) {
              clearTimeout(timer);
              pendingHistory.delete(requestId);
              reject(new HttpError(409, "device-offline"));
            }
          }),
        };
      });
      const page = await response;
      if (!(await store.ownsDevice(deviceId, principals.get(request)!)))
        throw new HttpError(404, "device-not-found");
      return page;
    },
  );
}
