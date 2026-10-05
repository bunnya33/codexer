import { z } from "zod";
import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { imageIdSchema } from "../../../../packages/protocol/src/index.js";
import { idSchema } from "../../../../packages/protocol/src/index.js";
import type { ImagePayload } from "../../../../packages/protocol/src/index.js";
import { decodeImage } from "../../../../packages/shared/src/images.js";
import { HttpError } from "../core/errors.js";
import { bearer } from "../auth/guards.js";
import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 会话图片上传、缓存与 Agent 回源。 */
export function registerImagesRoutes(app: FastifyInstance, context: RelayContext): void {
  const store = context.store;
  const queue = context.queue;
  const agents = context.connections.agents;
  const pendingImages = context.connections.pendingImages;
  const send = context.connections.send;
  const principals = context.guards.principals;
  const deviceAccess = context.guards.deviceAccess;

  app.post<{ Params: { deviceId: string; threadId: string } }>(
    "/v1/devices/:deviceId/threads/:threadId/images",
    { preHandler: deviceAccess, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const { deviceId, threadId } = z
        .object({ deviceId: idSchema, threadId: idSchema })
        .parse(request.params);
      if (!(await store.catalog(deviceId))?.threads.some((thread) => thread.id === threadId))
        throw new HttpError(404, "thread-not-in-catalog");
      let decoded;
      try {
        decoded = decodeImage(request.body);
      } catch {
        throw new HttpError(400, "invalid-image");
      }
      const id = createHash("sha256")
        .update(deviceId)
        .update("\0")
        .update(threadId)
        .update("\0")
        .update(decoded.bytes)
        .digest("hex");
      try {
        await queue.runDevice(deviceId, async () => {
          if (!(await store.ownsDevice(deviceId, principals.get(request)!)))
            throw new HttpError(404, "device-not-found");
          await store.saveImage(deviceId, threadId, id, decoded.image, true);
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(413, "image-storage-full");
      }
      return { id, name: decoded.image.name };
    },
  );

  app.get<{ Params: { deviceId: string; threadId: string; imageId: string } }>(
    "/v1/devices/:deviceId/threads/:threadId/images/:imageId",
    { preHandler: deviceAccess },
    async (request, reply) => {
      const { deviceId, threadId, imageId } = z
        .object({ deviceId: idSchema, threadId: idSchema, imageId: imageIdSchema })
        .parse(request.params);
      const { response } = await queue.runDevice(deviceId, async () => {
        if (!(await store.ownsDevice(deviceId, principals.get(request)!)))
          throw new HttpError(404, "device-not-found");
        if (!(await store.catalog(deviceId))?.threads.some((thread) => thread.id === threadId))
          throw new HttpError(404, "thread-not-in-catalog");
        let image = await store.image(deviceId, threadId, imageId);
        if (!image) {
          const agent = agents.get(deviceId);
          if (!agent || agent.socket.readyState !== WebSocket.OPEN)
            throw new HttpError(409, "device-offline");
          if (
            pendingImages.size >= 12 ||
            [...pendingImages.values()].filter((value) => value.deviceId === deviceId).length >= 4
          )
            throw new HttpError(429, "images-busy");
          const requestId = randomUUID();
          return {
            response: new Promise<ImagePayload>((resolve, reject) => {
              const timer = setTimeout(() => {
                pendingImages.delete(requestId);
                reject(new HttpError(504, "image-timeout"));
              }, 15000);
              pendingImages.set(requestId, { deviceId, threadId, imageId, resolve, reject, timer });
              if (!send(agent.socket, { type: "image.request", requestId, threadId, imageId })) {
                clearTimeout(timer);
                pendingImages.delete(requestId);
                reject(new HttpError(409, "device-offline"));
              }
            }),
          };
        }
        return { response: Promise.resolve(image) };
      });
      // 回包处理也使用设备队列，因此等待响应必须在队列之外。
      const image = await response;
      if (!(await store.ownsDevice(deviceId, principals.get(request)!)))
        throw new HttpError(404, "device-not-found");
      const { bytes } = decodeImage(image);
      return reply
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'")
        .type(image.mimeType)
        .send(bytes);
    },
  );

  app.get<{ Params: { deviceId: string; threadId: string; imageId: string } }>(
    "/v1/agent/:deviceId/threads/:threadId/images/:imageId",
    {
      preHandler: async (request) => {
        const { deviceId } = request.params as { deviceId: string };
        if (!(await store.authorizeDevice(deviceId, bearer(request))))
          throw new HttpError(401, "unauthorized");
      },
    },
    async (request) => {
      const { deviceId, threadId, imageId } = z
        .object({ deviceId: idSchema, threadId: idSchema, imageId: imageIdSchema })
        .parse(request.params);
      const image = await store.image(deviceId, threadId, imageId, true);
      if (!image) throw new HttpError(404, "image-not-in-thread");
      return image;
    },
  );
}
