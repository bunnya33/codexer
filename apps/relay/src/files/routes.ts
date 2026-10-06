import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { WebSocket } from "ws";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { idSchema } from "../../../../packages/protocol/src/index.js";
import {
  FILE_CHUNK_BYTES,
  filePathSchema,
  fileVersionSchema,
} from "../../../../packages/protocol/src/files.js";
import type { FilePayload } from "../../../../packages/protocol/src/files.js";
import { bearer } from "../auth/guards.js";
import type { RelayContext } from "../core/context.js";
import { HttpError } from "../core/errors.js";

const paramsSchema = z.object({ deviceId: idSchema, threadId: idSchema });
const infoQuery = z.object({ path: filePathSchema });
const contentQuery = infoQuery.extend({ version: fileVersionSchema });

/** 文件只在传输时回源；不缓存字节，元数据请求也不读取文件内容。 */
export function registerFilesRoutes(app: FastifyInstance, context: RelayContext): void {
  const { store, queue, connections } = context;
  const { pendingFiles, agents, send } = connections;
  const transfers = new Map<AbortController, string>();

  async function authorize(request: FastifyRequest, deviceId: string, threadId: string) {
    if (context.closing) throw new HttpError(503, "relay-closing");
    const principal = await store.sessionPrincipal(bearer(request));
    if (!principal) throw new HttpError(401, "unauthorized");
    if (!(await store.ownsDevice(deviceId, principal)))
      throw new HttpError(404, "device-not-found");
    if (
      !(await store.catalog(deviceId))?.threads.some(
        (thread) => thread.id === threadId && !thread.archived,
      )
    )
      throw new HttpError(404, "thread-not-in-catalog");
  }

  async function read(
    request: FastifyRequest,
    deviceId: string,
    threadId: string,
    path: string,
    signal: AbortSignal,
    offset?: number,
    version?: string,
  ) {
    const { response } = await queue.runDevice(deviceId, async () => {
      if (signal.aborted) throw new HttpError(499, "file-cancelled");
      await authorize(request, deviceId, threadId);
      const agent = agents.get(deviceId);
      if (!agent || agent.socket.readyState !== WebSocket.OPEN)
        throw new HttpError(409, "device-offline");
      if (!agent.filesSupported) throw new HttpError(409, "agent-update-required");
      if (
        pendingFiles.size >= 12 ||
        [...pendingFiles.values()].filter((value) => value.deviceId === deviceId).length >= 4
      )
        throw new HttpError(429, "files-busy");
      const requestId = randomUUID();
      const response = new Promise<FilePayload>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", aborted);
          pendingFiles.delete(requestId);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const aborted = () => fail(new HttpError(499, "file-cancelled"));
        const timer = setTimeout(() => fail(new HttpError(504, "file-timeout")), 15000);
        pendingFiles.set(requestId, {
          deviceId,
          threadId,
          path,
          offset,
          version,
          resolve: (file) => {
            cleanup();
            resolve(file);
          },
          reject: fail,
          timer,
        });
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
        else if (
          !send(agent.socket, {
            type: "file.request",
            requestId,
            threadId,
            path,
            ...(offset === undefined ? {} : { offset, version }),
          })
        )
          fail(new HttpError(409, "device-offline"));
      });
      return { response };
    });
    // 文件回包共用设备队列，等待响应必须在队列外，才能继续处理命令和会话事件。
    const file = await response;
    if (signal.aborted) throw new HttpError(499, "file-cancelled");
    await queue.runDevice(deviceId, () => authorize(request, deviceId, threadId));
    return file;
  }

  app.get(
    "/v1/devices/:deviceId/threads/:threadId/files/info",
    { preHandler: context.guards.deviceAccess },
    async (request, reply) => {
      const { deviceId, threadId } = paramsSchema.parse(request.params);
      const { path } = infoQuery.parse(request.query);
      const controller = new AbortController();
      const abort = () => controller.abort();
      reply.raw.once("close", abort);
      request.raw.once("aborted", abort);
      try {
        const file = await read(request, deviceId, threadId, path, controller.signal);
        return reply.header("Cache-Control", "no-store").send(file);
      } finally {
        reply.raw.removeListener("close", abort);
        request.raw.removeListener("aborted", abort);
      }
    },
  );

  app.get(
    "/v1/devices/:deviceId/threads/:threadId/files/content",
    { preHandler: context.guards.deviceAccess },
    async (request, reply) => {
      const { deviceId, threadId } = paramsSchema.parse(request.params);
      const { path, version } = contentQuery.parse(request.query);
      if (
        transfers.size >= 4 ||
        [...transfers.values()].filter((value) => value === deviceId).length >= 2
      )
        throw new HttpError(429, "files-busy");
      const controller = new AbortController();
      transfers.set(controller, deviceId);
      const cleanup = () => {
        controller.abort();
        transfers.delete(controller);
        reply.raw.removeListener("close", cleanup);
        request.raw.removeListener("aborted", cleanup);
      };
      reply.raw.once("close", cleanup);
      request.raw.once("aborted", cleanup);
      try {
        // 首块在发送响应头之前校验，过期版本、离线等错误仍返回明确 HTTP 状态。
        const first = await read(request, deviceId, threadId, path, controller.signal, 0, version);
        const stream = Readable.from(
          (async function* () {
            try {
              let file = first;
              let offset = 0;
              while (offset < first.size) {
                if (file.size !== first.size || file.name !== first.name)
                  throw new HttpError(409, "file-changed");
                const bytes = Buffer.from(file.base64!, "base64");
                yield bytes;
                offset += bytes.length;
                if (offset < first.size)
                  file = await read(
                    request,
                    deviceId,
                    threadId,
                    path,
                    controller.signal,
                    offset,
                    version,
                  );
              }
            } finally {
              // 读取结束后停止回源；传输名额保留到 HTTP 响应关闭，包含最后一块的发送。
              controller.abort();
            }
          })(),
          { objectMode: false, highWaterMark: FILE_CHUNK_BYTES },
        );
        return reply
          .header("Cache-Control", "no-store")
          .header("X-Content-Type-Options", "nosniff")
          .header("Content-Security-Policy", "default-src 'none'")
          .header("Content-Length", first.size)
          .header(
            "Content-Disposition",
            `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(first.name).replaceAll("'", "%27")}`,
          )
          .type("application/octet-stream")
          .send(stream);
      } catch (error) {
        cleanup();
        throw error;
      }
    },
  );
}
