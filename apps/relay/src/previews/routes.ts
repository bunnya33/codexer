import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { WebSocket } from "ws";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { localPreviewUrl } from "../../../../packages/client-shared/src/previews.js";
import { widgetState } from "../../../../packages/client-shared/src/previews.js";
import type { WidgetState } from "../../../../packages/client-shared/src/previews.js";
import { buildPreviewDocument } from "../../../../packages/client-shared/src/preview-runtime.js";
import {
  MAX_PREVIEW_RESPONSE_BYTES,
  PREVIEW_CHUNK_BYTES,
} from "../../../../packages/protocol/src/previews.js";
import type { PreviewResponse } from "../../../../packages/protocol/src/previews.js";
import type { RelayContext } from "../core/context.js";
import { HttpError } from "../core/errors.js";
import { rewritePreviewContent } from "./rewrite.js";
import type { Principal } from "../auth/types.js";

type Session = {
  deviceId: string;
  threadId: string;
  origin: string;
  sessionHash: string;
  principal: Principal;
  expiresAt: number;
  cookies: Map<string, string>;
  channel: string;
  state: WidgetState | null;
};
const tokenParams = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) });
const TTL = 30 * 60 * 1000;

export function registerPreviewRoutes(app: FastifyInstance, context: RelayContext) {
  const { store, connections } = context;
  const sessions = new Map<string, Session>();
  const timers = new Set<NodeJS.Timeout>();
  async function sessionFor(request: FastifyRequest): Promise<Session> {
    const { token } = tokenParams.parse(request.params);
    const session = sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(token);
      throw new HttpError(410, "preview-expired");
    }
    const principal = await store.sessionForHash(session.sessionHash);
    if (!principal || !(await store.ownsDevice(session.deviceId, principal)))
      throw new HttpError(401, "preview-revoked");
    if (
      !(await store.catalog(session.deviceId))?.threads.some(
        (thread) => thread.id === session.threadId && !thread.archived,
      )
    )
      throw new HttpError(404, "thread-not-in-catalog");
    const agent = connections.agents.get(session.deviceId);
    if (!agent || agent.socket.readyState !== WebSocket.OPEN)
      throw new HttpError(409, "device-offline");
    if (!agent.previewsSupported) throw new HttpError(409, "agent-update-required");
    return session;
  }

  app.post(
    "/v1/devices/:deviceId/threads/:threadId/previews",
    { preHandler: context.guards.deviceAccess },
    async (request, reply) => {
      const { deviceId, threadId } = z
        .object({ deviceId: z.string().max(160), threadId: z.string().max(160) })
        .parse(request.params);
      const { url, channel, state } = z
        .object({
          url: z.string().max(2048),
          channel: z.string().min(1).max(160),
          state: z.unknown().optional(),
        })
        .parse(request.body);
      const local = localPreviewUrl(url);
      if (!local) throw new HttpError(400, "invalid-preview-url");
      const principal = context.guards.principals.get(request)!;
      if (principal.kind !== "user") throw new HttpError(403, "control-account-required");
      for (const [token, session] of sessions)
        if (session.expiresAt <= Date.now()) sessions.delete(token);
      if (
        sessions.size >= 1000 ||
        [...sessions.values()].filter((session) => session.sessionHash === principal.sessionHash)
          .length >= 20
      )
        throw new HttpError(429, "previews-busy");
      const target = new URL(local),
        token = randomBytes(32).toString("hex");
      const session: Session = {
        deviceId,
        threadId,
        origin: target.origin,
        sessionHash: principal.sessionHash!,
        principal,
        expiresAt: Date.now() + TTL,
        cookies: new Map(),
        channel,
        state: widgetState(state),
      };
      sessions.set(token, session);
      try {
        await sessionFor({ ...request, params: { token } } as FastifyRequest);
      } catch (error) {
        sessions.delete(token);
        throw error;
      }
      reply.header("Cache-Control", "no-store");
      return {
        path: `/v1/previews/${token}${target.pathname}${target.search}${target.hash}`,
        expiresAt: session.expiresAt,
      };
    },
  );

  app.delete("/v1/previews/:token", { preHandler: context.guards.control }, async (request) => {
    const { token } = tokenParams.parse(request.params);
    const principal = context.guards.principals.get(request)!;
    const session = sessions.get(token);
    if (!session || session.sessionHash !== principal.sessionHash)
      throw new HttpError(404, "preview-not-found");
    sessions.delete(token);
    for (const [id, pending] of connections.pendingPreviews)
      if (pending.token === token) {
        connections.pendingPreviews.delete(id);
        pending.reject(new HttpError(410, "preview-closed"));
      }
    return { closed: true };
  });

  app.get(
    "/v1/previews/:token/__socket",
    {
      websocket: true,
      config: { rateLimit: false },
      preValidation: async (request) => {
        const session = await sessionFor(request);
        if (
          connections.pendingPreviews.size >= 128 ||
          [...connections.pendingPreviews.values()].filter(
            (value) => value.deviceId === session.deviceId,
          ).length >= 24
        )
          throw new HttpError(429, "previews-busy");
      },
    },
    (socket, request) => {
      const { token } = tokenParams.parse(request.params),
        session = sessions.get(token)!;
      const query = z.object({ path: z.string().max(8192) }).parse(request.query);
      const requestId = randomUUID(),
        agent = connections.agents.get(session.deviceId)!;
      let ready = false;
      const waiting: { data: string; binary: boolean }[] = [];
      const opening = setTimeout(() => socket.close(1011, "preview-websocket-timeout"), 10000);
      timers.add(opening);
      const expire = setTimeout(
        () => socket.close(1008, "preview-expired"),
        Math.max(1, session.expiresAt - Date.now()),
      );
      timers.add(expire);
      const cleanup = () => {
        clearTimeout(expire);
        timers.delete(expire);
        connections.pendingPreviews.delete(requestId);
        clearTimeout(opening);
        timers.delete(opening);
        connections.send(agent.socket, { type: "preview.cancel", requestId });
      };
      connections.pendingPreviews.set(requestId, {
        deviceId: session.deviceId,
        principal: session.principal,
        token,
        accept: (message) => {
          const event = message.event;
          if (event.type === "ws.open") {
            ready = true;
            clearTimeout(opening);
            timers.delete(opening);
            for (const value of waiting.splice(0))
              connections.send(agent.socket, { type: "preview.ws.data", requestId, ...value });
          } else if (event.type === "ws.data" && socket.readyState === WebSocket.OPEN) {
            if (socket.bufferedAmount > 2 * 1024 * 1024) {
              socket.close(1013, "backpressure");
              return;
            }
            socket.send(Buffer.from(event.data, "base64"), { binary: event.binary });
          } else if (event.type === "ws.close" || event.type === "error")
            socket.close(1011, "preview-websocket-closed");
        },
        reject: () => {
          socket.close(1008, "preview-unavailable");
          cleanup();
        },
      });
      const protocols = (request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (
        !connections.send(agent.socket, {
          type: "preview.ws.open",
          requestId,
          threadId: session.threadId,
          origin: session.origin,
          path: query.path,
          protocols,
        })
      )
        socket.close(1011, "device-offline");
      socket.on("message", (data, binary) => {
        const bytes = Buffer.from(data as Buffer);
        if (bytes.length > PREVIEW_CHUNK_BYTES || waiting.length >= 16) {
          socket.close(1009, "preview-message-too-large");
          return;
        }
        const value = { data: bytes.toString("base64"), binary };
        if (!ready) waiting.push(value);
        else if (!connections.send(agent.socket, { type: "preview.ws.data", requestId, ...value }))
          socket.close(1011, "device-offline");
      });
      socket.on("error", cleanup);
      socket.on("close", cleanup);
    },
  );

  // A parser scoped to this plugin forwards API payloads verbatim instead of JSON reserialization.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );
    scope.route({
      method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      url: "/v1/previews/:token/*",
      config: { rateLimit: false },
      handler: async (request, reply) => {
        const session = await sessionFor(request),
          { token } = tokenParams.parse(request.params);
        const prefix = `/v1/previews/${token}/`;
        const path = "/" + request.raw.url!.slice(prefix.length);
        const agent = connections.agents.get(session.deviceId)!;
        if (
          connections.pendingPreviews.size >= 128 ||
          [...connections.pendingPreviews.values()].filter(
            (value) => value.deviceId === session.deviceId,
          ).length >= 24
        )
          throw new HttpError(429, "previews-busy");
        const requestId = randomUUID(),
          chunks: Buffer[] = [];
        let expiry: NodeJS.Timeout | undefined;
        let size = 0,
          status = 502,
          headers: Record<string, string> = {},
          stream: Readable | undefined;
        let resolve!: (value: Buffer | Readable) => void, reject!: (error: Error) => void;
        const result = new Promise<Buffer | Readable>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        const cleanup = () => {
          clearTimeout(timeout);
          timers.delete(timeout);
          connections.pendingPreviews.delete(requestId);
          if (expiry) {
            clearTimeout(expiry);
            timers.delete(expiry);
          }
          connections.send(agent.socket, { type: "preview.cancel", requestId });
        };
        const fail = (error: Error) => {
          if (stream) stream.destroy(error);
          reject(error);
          cleanup();
        };
        const timeout = setTimeout(() => fail(new HttpError(504, "preview-timeout")), 25000);
        timers.add(timeout);
        const cancelled = () => fail(new HttpError(499, "preview-cancelled"));
        request.raw.once("aborted", cancelled);
        reply.raw.once("close", () => {
          if (!reply.raw.writableEnded) cancelled();
          else cleanup();
        });
        connections.pendingPreviews.set(requestId, {
          deviceId: session.deviceId,
          principal: session.principal,
          token,
          reject: fail,
          accept: (message) => {
            const event: PreviewResponse["event"] = message.event;
            if (event.type === "headers") {
              status = event.status;
              headers = event.headers;
              if (headers["content-type"]?.includes("text/event-stream")) {
                stream = new Readable({ read() {} });
                resolve(stream);
                clearTimeout(timeout);
                timers.delete(timeout);
                expiry = setTimeout(
                  () => fail(new HttpError(410, "preview-expired")),
                  Math.max(1, session.expiresAt - Date.now()),
                );
                timers.add(expiry);
              }
            } else if (event.type === "data") {
              const bytes = Buffer.from(event.data, "base64");
              size += bytes.length;
              if (size > MAX_PREVIEW_RESPONSE_BYTES) {
                fail(new HttpError(413, "preview-response-too-large"));
                return;
              }
              if (stream) {
                if (!stream.push(bytes) && stream.readableLength > 2 * 1024 * 1024)
                  fail(new HttpError(429, "preview-backpressure"));
              } else chunks.push(bytes);
            } else if (event.type === "end") {
              stream?.push(null);
              resolve(Buffer.concat(chunks));
              cleanup();
            } else if (event.type === "error")
              fail(new HttpError(event.code === "preview-not-in-thread" ? 404 : 502, event.code));
          },
        });
        const forwarded: Record<string, string> = {};
        for (const key of ["accept", "content-type", "range"])
          if (typeof request.headers[key] === "string") forwarded[key] = request.headers[key]!;
        if (session.cookies.size)
          forwarded.cookie = [...session.cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join("; ");
        connections.send(agent.socket, {
          type: "preview.request",
          requestId,
          threadId: session.threadId,
          origin: session.origin,
          path,
          method: request.method,
          headers: forwarded,
          ...(Buffer.isBuffer(request.body) ? { body: request.body.toString("base64") } : {}),
        });
        try {
          let body = await result;
          for (const cookie of (headers["set-cookie"] ?? "").split("\n")) {
            const pair = cookie.split(";")[0]!,
              equal = pair.indexOf("=");
            if (equal > 0 && session.cookies.size < 100)
              session.cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
          }
          const type = headers["content-type"] || "application/octet-stream";
          if (Buffer.isBuffer(body) && /text\/html|javascript|ecmascript|text\/css/.test(type)) {
            let text = rewritePreviewContent(
              body.toString("utf8"),
              type,
              prefix,
              session.origin,
              path,
            );
            if (/text\/html/.test(type))
              text = buildPreviewDocument(text, session.channel, session.state, true);
            body = Buffer.from(text);
          }
          reply
            .code(status)
            .header("Content-Type", type)
            .header("Cache-Control", "no-store")
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Headers", "Content-Type, Range")
            .header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
            .header("Referrer-Policy", "no-referrer");
          // Sandboxing is enforced by the response too, so opening the URL cannot gain Relay origin access.
          reply.header(
            "Content-Security-Policy",
            `sandbox allow-scripts allow-forms; default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; connect-src 'self' ws: wss: https:; frame-src 'none'; object-src 'none'`,
          );
          if (headers.location) {
            const location = new URL(headers.location, new URL(path, session.origin));
            if (location.origin !== session.origin)
              throw new HttpError(502, "preview-external-redirect");
            reply.header(
              "Location",
              prefix + location.pathname.slice(1) + location.search + location.hash,
            );
          }
          if (headers["content-range"]) reply.header("Content-Range", headers["content-range"]);
          if (headers["accept-ranges"]) reply.header("Accept-Ranges", headers["accept-ranges"]);
          return reply.send(body);
        } finally {
          if (!stream) cleanup();
          request.raw.removeListener("aborted", cancelled);
        }
      },
    });
  });
  app.addHook("onClose", async () => {
    timers.forEach(clearTimeout);
    sessions.clear();
  });
}
