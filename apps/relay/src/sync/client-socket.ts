import { z } from "zod";
import { WebSocket } from "ws";
import { clientMessageSchema } from "../../../../packages/protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../../../packages/protocol/src/index.js";
import type { ClientConnection } from "../transport/connections.js";
import { HttpError } from "../core/errors.js";
import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 入队时同时登记客户端顺序和设备顺序，重放期间不会插入实时事件。 */
export function registerSyncClientSocket(app: FastifyInstance, context: RelayContext): void {
  const store = context.store;
  const queue = context.queue;
  const agents = context.connections.agents;
  const clients = context.connections.clients;
  const send = context.connections.send;
  const submit = context.commands.submit;
  const originAllowed = context.guards.originAllowed;

  app.get("/v1/ws/client", { websocket: true }, (socket, request) => {
    if (!originAllowed(request)) {
      socket.close(1008, "origin-denied");
      return;
    }
    const client: ClientConnection = {
      socket,
      principal: null,
      devices: new Set(),
      lastPong: Date.now(),
      messages: 0,
      windowStart: Date.now(),
      authTimer: setTimeout(() => socket.close(1008, "authentication-required"), 5000),
    };
    clients.add(client);
    socket.on("error", () => undefined);
    socket.on("pong", () => {
      client.lastPong = Date.now();
    });
    socket.on("close", () => {
      clearTimeout(client.authTimer);
      context.connections.removeClient(client);
    });
    socket.on("message", (bytes, binary) => {
      if (binary) {
        socket.close(1003, "text-required");
        return;
      }
      if (Date.now() - client.windowStart > 60000) {
        client.messages = 0;
        client.windowStart = Date.now();
      }
      if (++client.messages > 60) {
        socket.close(1008, "rate-limited");
        return;
      }
      let message: z.infer<typeof clientMessageSchema>;
      try {
        message = clientMessageSchema.parse(JSON.parse(bytes.toString()));
      } catch {
        socket.close(1008, "invalid-message");
        return;
      }
      const operation = async () => {
        if (context.closing) return;
        if (socket.readyState !== WebSocket.OPEN) return;
        if (message.type === "client.authenticate") {
          if (client.principal) {
            socket.close(1008, "invalid-ticket");
            return;
          }
          const principal = await store.consumeTicket(message.ticket);
          if (!principal) {
            socket.close(1008, "invalid-ticket");
            return;
          }
          clearTimeout(client.authTimer);
          client.principal = principal;
          send(socket, { type: "client.authenticated", protocolVersion: PROTOCOL_VERSION });
          return;
        }
        const principal = client.principal;
        if (!principal) {
          socket.close(1008, "authentication-required");
          return;
        }
        if (!(await store.sessionForHash(principal.sessionHash!))) {
          socket.close(4003, "session-expired");
          return;
        }
        if (message.type === "client.command") {
          if (!(await store.ownsDevice(message.command.deviceId, principal)))
            throw new HttpError(404, "device-not-found");
          send(socket, await submit(message.command));
          return;
        }
        if (!(await store.ownsDevice(message.deviceId, principal)))
          throw new HttpError(404, "device-not-found");
        const snapshot = await store.snapshot(message.deviceId);
        if (!snapshot) throw new HttpError(404, "snapshot-not-found");
        if (client.devices.size >= 20 && !client.devices.has(message.deviceId))
          throw new HttpError(400, "subscription-limit");
        if (!context.connections.subscribe(client, message.deviceId)) return;
        const events =
          message.epoch !== undefined && message.lastSeq !== undefined
            ? await store.replay(message.deviceId, message.epoch, message.lastSeq)
            : null;
        send(socket, {
          type: "sync.begin",
          deviceId: message.deviceId,
          epoch: snapshot.epoch,
          lastSeq: snapshot.lastSeq,
          mode: events === null ? "snapshot" : "replay",
        });
        if (events === null) send(socket, { type: "device.snapshot", snapshot });
        else for (const event of events) send(socket, { type: "device.event", event });
        send(socket, {
          type: "sync.ready",
          deviceId: message.deviceId,
          epoch: snapshot.epoch,
          lastSeq: snapshot.lastSeq,
        });
        send(socket, {
          type: "device.presence",
          deviceId: message.deviceId,
          online: agents.has(message.deviceId),
        });
      };
      // 必须在接收消息时登记依赖，而不是在前一个任务内再入队，避免屏障循环等待。
      const result =
        message.type === "client.authenticate"
          ? queue.run(operation, client.pending)
          : queue.runDevice(
              message.type === "client.command" ? message.command.deviceId : message.deviceId,
              operation,
              client.pending,
            );
      client.pending = result.catch(() => undefined);
      void result.catch((error) =>
        send(socket, {
          type: "error",
          code: error instanceof HttpError ? error.code : "server-error",
        }),
      );
    });
  });
}
