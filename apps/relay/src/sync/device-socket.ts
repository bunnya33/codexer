import { z } from "zod";
import { WebSocket } from "ws";
import { deviceMessageSchema } from "../../../../packages/protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../../../packages/protocol/src/index.js";
import { FILE_CHUNK_BYTES } from "../../../../packages/protocol/src/files.js";
import { decodeImage } from "../../../../packages/shared/src/images.js";
import { jsonForStorage } from "../../../../packages/shared/src/json.js";
import type { AgentConnection } from "../transport/connections.js";
import { HttpError } from "../core/errors.js";
import { bearer } from "../auth/guards.js";
import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 同设备连接替换、事件、命令与重放共用队列，不同设备可并行。 */
export function registerSyncDeviceSocket(app: FastifyInstance, context: RelayContext): void {
  const store = context.store;
  const queue = context.queue;
  const agents = context.connections.agents;
  const pendingHistory = context.connections.pendingHistory;
  const pendingImages = context.connections.pendingImages;
  const pendingFiles = context.connections.pendingFiles;
  const send = context.connections.send;
  const broadcast = context.connections.broadcast;
  const failHistory = context.connections.failRequests;
  const principals = context.guards.principals;
  const originAllowed = context.guards.originAllowed;

  app.get(
    "/v1/ws/device",
    {
      websocket: true,
      preValidation: async (request) => {
        if (!originAllowed(request)) throw new HttpError(403, "origin-denied");
        const id = request.headers["x-device-id"];
        const principal =
          typeof id === "string" ? await store.sessionPrincipal(bearer(request), id) : null;
        if (!principal || principal.kind !== "user") throw new HttpError(401, "unauthorized");
        principals.set(request, principal);
      },
    },
    (socket, request) => {
      const deviceId = String(request.headers["x-device-id"]);
      const connection: AgentConnection = {
        socket,
        lastPong: Date.now(),
        principal: principals.get(request)!,
      };
      socket.on("error", () => undefined);
      socket.on("pong", () => {
        connection.lastPong = Date.now();
      });
      void queue
        .runDevice(deviceId, async () => {
          if (
            context.closing ||
            socket.readyState !== WebSocket.OPEN ||
            !(await store.authorizeDevice(deviceId, bearer(request)))
          ) {
            socket.close(4003, "revoked");
            return;
          }
          const previous = agents.get(deviceId);
          if (previous) failHistory(deviceId, 409, "connection-replaced");
          agents.set(deviceId, connection);
          previous?.socket.close(4001, "connection-replaced");
          await store.touch(deviceId);
          send(socket, {
            type: "device.welcome",
            deviceId,
            protocolVersion: PROTOCOL_VERSION,
            features: ["catalog", "history", "images", "files", "previews"],
          });
          broadcast(deviceId, { type: "device.presence", deviceId, online: true });
        })
        .catch(() => socket.close(1011, "server-error"));
      socket.on("message", (bytes, binary) => {
        if (binary) {
          socket.close(1003, "text-required");
          return;
        }
        let message: z.infer<typeof deviceMessageSchema>;
        // Normalize observation text before validation, broadcasting and JSONB persistence.
        // Control commands sent to the PC are not changed by this path.
        try {
          message = deviceMessageSchema.parse(
            JSON.parse(jsonForStorage(JSON.parse(bytes.toString()))),
          );
        } catch {
          socket.close(1008, "invalid-message");
          return;
        }
        if (message.type === "device.preview") {
          if (agents.get(deviceId) !== connection || context.closing) return;
          const pending = context.connections.pendingPreviews.get(message.requestId);
          if (pending?.deviceId === deviceId) pending.accept(message);
          return;
        }
        void queue
          .runDevice(deviceId, async () => {
            if (context.closing) return;
            if (agents.get(deviceId) !== connection) return;
            if (!(await store.sessionForHash(connection.principal.sessionHash!, deviceId))) {
              socket.close(4003, "session-expired");
              return;
            }
            if (message.type === "device.capabilities") {
              connection.filesSupported = message.features.includes("files");
              connection.previewsSupported = message.features.includes("previews");
            } else if (message.type === "device.file") {
              const pending = pendingFiles.get(message.requestId);
              if (
                !pending ||
                pending.deviceId !== deviceId ||
                pending.threadId !== message.threadId ||
                pending.path !== message.path
              )
                return;
              clearTimeout(pending.timer);
              pendingFiles.delete(message.requestId);
              const file = message.file;
              if (!file) {
                const status =
                  message.code === "file-too-large"
                    ? 413
                    : message.code === "file-changed"
                      ? 409
                      : 404;
                pending.reject(new HttpError(status, message.code ?? "file-unavailable"));
              } else if (
                message.code ||
                file.offset !== pending.offset ||
                (pending.offset === undefined
                  ? file.base64 !== undefined
                  : file.version !== pending.version ||
                    file.base64 === undefined ||
                    Buffer.from(file.base64, "base64").length !==
                      Math.min(FILE_CHUNK_BYTES, file.size - pending.offset))
              ) {
                pending.reject(new HttpError(502, "invalid-file-response"));
              } else pending.resolve(file);
            } else if (message.type === "device.snapshot") {
              if (message.snapshot.deviceId !== deviceId) throw new Error("device-mismatch");
              await store.saveSnapshot(message.snapshot);
              broadcast(deviceId, message);
            } else if (message.type === "device.catalog") {
              if (message.catalog.deviceId !== deviceId) throw new Error("device-mismatch");
              await store.saveCatalog(message.catalog);
              broadcast(deviceId, {
                type: "catalog.updated",
                deviceId,
                generatedAt: message.catalog.generatedAt,
              });
            } else if (message.type === "device.history") {
              const pending = pendingHistory.get(message.requestId);
              if (
                !pending ||
                pending.deviceId !== deviceId ||
                pending.threadId !== message.threadId
              )
                return;
              clearTimeout(pending.timer);
              pendingHistory.delete(message.requestId);
              if (message.page && message.page.threadId === message.threadId)
                pending.resolve(message.page);
              else pending.reject(new HttpError(502, message.code ?? "history-unavailable"));
            } else if (message.type === "device.image") {
              const pending = pendingImages.get(message.requestId);
              if (
                !pending ||
                pending.deviceId !== deviceId ||
                pending.threadId !== message.threadId ||
                pending.imageId !== message.imageId
              )
                return;
              clearTimeout(pending.timer);
              pendingImages.delete(message.requestId);
              if (!message.image) {
                pending.reject(new HttpError(404, "image-unavailable"));
                return;
              }
              try {
                decodeImage(message.image);
                await store.saveImage(
                  deviceId,
                  message.threadId,
                  message.imageId,
                  message.image,
                  false,
                );
                pending.resolve(message.image);
              } catch {
                pending.reject(new HttpError(400, "invalid-image"));
              }
            } else if (message.type === "device.event") {
              if (message.event.deviceId !== deviceId) throw new Error("device-mismatch");
              try {
                await store.saveEvent(message.event);
                broadcast(deviceId, message);
              } catch {
                send(socket, { type: "device.resync", reason: "sequence-gap" });
              }
            } else {
              if (message.result.deviceId !== deviceId) throw new Error("device-mismatch");
              if (await store.finishCommand(message.result)) {
                broadcast(deviceId, message);
                await store.weixin.commandResult(message.result);
              }
            }
          })
          .catch((error) => {
            const reason = error instanceof Error ? error.message : "";
            if (reason === "device-mismatch" || reason === "stale-snapshot")
              socket.close(1008, reason);
            else {
              // Do not log SQL statements, payloads, identifiers or raw exception messages.
              const sqlState =
                typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
                  ? error.code
                  : undefined;
              console.warn(
                JSON.stringify({
                  type: "relay.diagnostic",
                  code: "relay-storage-error",
                  ...(sqlState ? { sqlState } : {}),
                }),
              );
              socket.close(1011, "storage-error");
            }
          });
      });
      socket.on("close", () => {
        void queue
          .runDevice(deviceId, async () => {
            if (agents.get(deviceId) !== connection) return;
            agents.delete(deviceId);
            failHistory(deviceId, 409, "device-offline");
            await store.touch(deviceId);
            broadcast(deviceId, { type: "device.presence", deviceId, online: false });
          })
          .catch(() => undefined);
      });
    },
  );
}
