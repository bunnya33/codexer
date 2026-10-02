import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { WebSocket } from "ws";
import { z } from "zod";
import { clientMessageSchema, commandSchema, deviceMessageSchema, imageIdSchema, idSchema, MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from "../../../packages/protocol/src/index.js";
import type { HistoryPage, ImagePayload, RemoteCommand } from "../../../packages/protocol/src/index.js";
import { decodeImage } from "../../../packages/shared/src/images.js";
import { SerialQueue } from "../../../packages/shared/src/queue.js";
import { jsonForStorage } from "../../../packages/shared/src/json.js";
import { authSettingsSchema } from "../../../packages/shared/src/session-policy.js";
import { hash, RelayStore } from "./store.js";
import type { Principal } from "./store.js";

class HttpError extends Error { constructor(readonly statusCode: number, readonly code: string) { super(code); } }
function bearer(request: FastifyRequest): string { const value = request.headers.authorization; return value?.startsWith("Bearer ") ? value.slice(7) : ""; }
type AgentConnection = { socket: WebSocket; lastPong: number; principal: Principal };
type ClientConnection = { socket: WebSocket; principal: Principal | null; devices: Set<string>; lastPong: number; messages: number; windowStart: number; authTimer: NodeJS.Timeout };
type PendingHistory = { deviceId: string; threadId: string; resolve: (page: HistoryPage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type PendingImage = { deviceId: string; threadId: string; imageId: string; resolve: (image: ImagePayload) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export async function createRelay(options: { store: RelayStore; allowedOrigins?: string[]; heartbeatMs?: number; webRoot?: string; adminRoot?: string }) {
  const app = Fastify({ logger: false, bodyLimit: MAX_MESSAGE_BYTES });
  await app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false } });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, { root: options.webRoot, prefix: "/", index: "index.html" });
  }
  if (options.adminRoot && existsSync(options.adminRoot)) {
    await app.register(fastifyStatic, { root: options.adminRoot, prefix: "/admin/", index: "index.html", decorateReply: !options.webRoot || !existsSync(options.webRoot) });
    app.get("/admin", async (_request, reply) => reply.redirect("/admin/"));
  }
  const { store } = options;
  const agents = new Map<string, AgentConnection>();
  const clients = new Set<ClientConnection>();
  const pendingHistory = new Map<string, PendingHistory>();
  const pendingImages = new Map<string, PendingImage>();
  const queue = new SerialQueue();
  const principals = new WeakMap<FastifyRequest, Principal>();
  const origins = new Set(options.allowedOrigins ?? []);
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && originAllowed(request)) {
      reply.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    }
  });
  app.options("/v1/*", async (request, reply) => {
    if (!request.headers.origin || !originAllowed(request)) return reply.code(403).send({ error: "origin-denied" });
    return reply.code(204).send();
  });
  let closing = false;
  const authenticate = async (request: FastifyRequest): Promise<Principal> => {
    const principal = await store.sessionPrincipal(bearer(request));
    if (!principal) throw new HttpError(401, "unauthorized");
    return principal;
  };
  const member = async (request: FastifyRequest) => { principals.set(request, await authenticate(request)); };
  const admin = async (request: FastifyRequest) => {
    const principal = await authenticate(request);
    if (principal.kind !== "admin") throw new HttpError(403, "admin-required");
    principals.set(request, principal);
  };
  const deviceAccess = async (request: FastifyRequest) => {
    const principal = await authenticate(request);
    const { deviceId } = request.params as { deviceId: string };
    if (!await store.ownsDevice(deviceId, principal)) throw new HttpError(404, "device-not-found");
    principals.set(request, principal);
  };
  const originAllowed = (request: FastifyRequest) => !request.headers.origin || origins.has(request.headers.origin) || request.headers.origin === `${request.protocol}://${request.headers.host}`;
  function send(socket: WebSocket, message: unknown): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 16 * 1024 * 1024) { socket.close(1013, "backpressure"); return false; }
    const json = JSON.stringify(message);
    if (Buffer.byteLength(json) > MAX_MESSAGE_BYTES) { socket.close(1009, "payload-too-large"); return false; }
    socket.send(json);
    return true;
  }
  function broadcast(deviceId: string, message: unknown): void {
    for (const client of clients) if (client.principal && client.devices.has(deviceId)) send(client.socket, message);
  }
  function failHistory(deviceId: string, status: number, code: string): void {
    for (const [id, pending] of pendingHistory) if (pending.deviceId === deviceId) { clearTimeout(pending.timer); pendingHistory.delete(id); pending.reject(new HttpError(status, code)); }
    for (const [id, pending] of pendingImages) if (pending.deviceId === deviceId) { clearTimeout(pending.timer); pendingImages.delete(id); pending.reject(new HttpError(status, code)); }
  }
  async function submit(command: RemoteCommand): Promise<unknown> {
    const previous = await store.command(command.deviceId, command.commandId);
    if (previous) {
      if (previous.payload_hash !== hash(JSON.stringify(command))) throw new HttpError(409, "command-id-reused");
      return previous.result ? { type: "command.result", result: previous.result } : { type: "command.accepted", commandId: command.commandId };
    }
    if (command.expiresAt <= Date.now() || command.expiresAt > Date.now() + 300000) throw new HttpError(400, "invalid-command-expiry");
    const agent = agents.get(command.deviceId);
    if (!agent || agent.socket.readyState !== WebSocket.OPEN) throw new HttpError(409, "device-offline");
    const snapshot = await store.snapshot(command.deviceId);
    if (!snapshot || snapshot.epoch !== command.expectedEpoch) throw new HttpError(409, "stale-device-epoch");
    if ((command.payload.type === "turn.start" || command.payload.type === "turn.queue" || command.payload.type === "turn.steer") && command.payload.images?.length) {
      for (const id of command.payload.images) if (!await store.image(command.deviceId, command.payload.threadId, id, true)) throw new HttpError(400, "image-not-in-thread");
      await store.retainImages(command.deviceId, command.payload.threadId, command.payload.images);
    }
    await store.addCommand(command);
    try { if (!send(agent.socket, { type: "command", command })) throw new Error("dispatch-failed"); }
    catch {
      const result = { deviceId: command.deviceId, commandId: command.commandId, status: "unknown" as const, code: "dispatch-unconfirmed" };
      await store.finishCommand(result);
      return { type: "command.result", result };
    }
    return { type: "command.accepted", commandId: command.commandId };
  }
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error instanceof HttpError ? error.statusCode : error instanceof z.ZodError ? 400 : error !== null && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
    void reply.code(statusCode).send({ error: error instanceof HttpError ? error.code : statusCode === 400 ? "invalid-request" : statusCode === 413 ? "request-too-large" : statusCode === 429 ? "rate-limited" : "server-error" });
  });
  app.get("/health", async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION }));
  const loginSchema = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(128) });
  const failures = new Map<string, { count: number; until: number }>();
  async function login(username: string, password: string) {
    const key = username.toLowerCase(), now = Date.now();
    for (const [name, entry] of failures) if (entry.until <= now) failures.delete(name);
    if ((failures.get(key)?.count ?? 0) >= 10) throw new HttpError(429, "login-rate-limited");
    const account = await store.checkPassword(username, password);
    if (!account) {
      const entry = failures.get(key) ?? { count: 0, until: now + 15 * 60000 };
      entry.count++; failures.set(key, entry);
      if (failures.size > 10000) failures.delete(failures.keys().next().value!);
      throw new HttpError(401, "invalid-account-or-password");
    }
    failures.delete(key);
    return account;
  }
  const loginOptions = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
  app.post("/v1/auth/login", loginOptions, async request => {
    if (!originAllowed(request)) throw new HttpError(403, "origin-denied");
    const { username, password } = loginSchema.parse(request.body);
    return queue.run(async () => {
      const account = await login(username, password);
      return { ...await store.createSession(account.id), role: account.kind, userId: account.id, username };
    });
  });
  app.post("/v1/agents/login", loginOptions, async request => {
    if (!originAllowed(request)) throw new HttpError(403, "origin-denied");
    const body = loginSchema.extend({ installationId: z.string().uuid(), name: z.string().trim().min(1).max(200), platform: z.enum(["win32", "darwin", "linux"]) }).parse(request.body);
    return queue.run(async () => {
      const account = await login(body.username, body.password);
      const deviceId = await store.registerAgent(account.id, body.installationId, body.name, body.platform);
      const previous = agents.get(deviceId);
      if (previous) closeSessions(value => value.sessionHash === previous.principal.sessionHash, "agent-login-replaced");
      return { ...await store.createSession(account.id, deviceId), deviceId, userId: account.id };
    });
  });
  function closeSessions(matches: (principal: Principal) => boolean, reason: string) {
    for (const client of clients) if (client.principal && matches(client.principal)) client.socket.close(4003, reason);
    for (const [id, agent] of agents) if (matches(agent.principal)) {
      agents.delete(id); agent.socket.close(4003, reason); failHistory(id, 401, reason);
      broadcast(id, { type: "device.presence", deviceId: id, online: false });
    }
  }
  app.post("/v1/auth/logout", { preHandler: member }, async request => queue.run(async () => {
    const principal = principals.get(request)!;
    await store.logout(principal.sessionHash!);
    closeSessions(value => value.sessionHash === principal.sessionHash, "logged-out");
    return { loggedOut: true };
  }));
  app.get("/v1/me", { preHandler: member }, async request => {
    const principal = principals.get(request)!;
    return { role: principal.kind, userId: principal.id };
  });
  app.post("/v1/auth/active", { preHandler: member }, async request => queue.run(async () => {
    const result = await store.touchSession(principals.get(request)!.sessionHash!);
    if (!result) throw new HttpError(401, "unauthorized");
    return result;
  }));
  app.get("/v1/admin/auth-settings", { preHandler: admin }, async () => store.authSettings());
  app.put("/v1/admin/auth-settings", { preHandler: admin }, async request => {
    const settings = authSettingsSchema.parse(request.body);
    return queue.run(() => store.setAuthSettings(settings));
  });
  app.post("/v1/users", { preHandler: admin }, async request => {
    const { username, password } = loginSchema.extend({ password: z.string().min(12).max(128) }).parse(request.body);
    try { return await queue.run(() => store.createUser(username, password)); }
    catch (error) { if ((error as { code?: string }).code === "23505") throw new HttpError(409, "account-name-taken"); throw error; }
  });
  app.get("/v1/users", { preHandler: admin }, async () => ({ users: await store.listUsers() }));
  app.delete<{ Params: { userId: string } }>("/v1/users/:userId", { preHandler: admin }, async request => queue.run(async () => {
    if (!await store.revokeUser(request.params.userId)) throw new HttpError(404, "user-not-found-or-admin");
    closeSessions(value => value.id === request.params.userId, "account-disabled");
    return { revoked: true };
  }));
  app.put<{ Params: { userId: string } }>("/v1/users/:userId/password", { preHandler: admin }, async request => {
    const { password } = z.object({ password: z.string().min(12).max(128) }).parse(request.body);
    return queue.run(async () => {
      if (!await store.resetPassword(request.params.userId, password)) throw new HttpError(404, "user-not-found");
      closeSessions(value => value.id === request.params.userId, "password-reset");
      return { reset: true };
    });
  });
  app.get("/v1/devices", { preHandler: member }, async request => { const principal = principals.get(request)!; return { devices: (await store.listDevices(principal)).map(device => ({ ...device, online: agents.has(String(device.id)) })) }; });
  app.delete<{ Params: { deviceId: string } }>("/v1/devices/:deviceId", { preHandler: deviceAccess }, async request => queue.run(async () => {
    if (!await store.ownsDevice(request.params.deviceId, principals.get(request)!)) throw new HttpError(404, "device-not-found");
    if (!await store.revoke(request.params.deviceId)) throw new HttpError(404, "device-not-found");
    agents.get(request.params.deviceId)?.socket.close(4003, "revoked");
    agents.delete(request.params.deviceId);
    failHistory(request.params.deviceId, 404, "device-revoked");
    broadcast(request.params.deviceId, { type: "device.presence", deviceId: request.params.deviceId, online: false });
    return { revoked: true };
  }));
  app.get<{ Params: { deviceId: string } }>("/v1/devices/:deviceId/snapshot", { preHandler: deviceAccess }, async request => {
    const snapshot = await store.snapshot(request.params.deviceId);
    if (!snapshot) throw new HttpError(404, "snapshot-not-found");
    return { online: agents.has(request.params.deviceId), snapshot };
  });
  app.get<{ Params: { deviceId: string } }>("/v1/devices/:deviceId/catalog", { preHandler: deviceAccess }, async request => {
    const catalog = await store.catalog(request.params.deviceId);
    if (!catalog) throw new HttpError(404, "catalog-not-ready");
    return { catalog };
  });
  app.get<{ Params: { deviceId: string; threadId: string }; Querystring: { cursor?: string } }>("/v1/devices/:deviceId/threads/:threadId/turns", { preHandler: deviceAccess }, async request => {
    const { deviceId, threadId } = request.params;
    if (!await store.ownsDevice(deviceId, principals.get(request)!)) throw new HttpError(404, "device-not-found");
    const { cursor } = z.object({ cursor: z.string().min(1).max(2048).optional() }).parse(request.query);
    const catalog = await store.catalog(deviceId);
    if (!catalog?.threads.some(thread => thread.id === threadId)) throw new HttpError(404, "thread-not-in-catalog");
    const agent = agents.get(deviceId);
    if (!agent || agent.socket.readyState !== WebSocket.OPEN) throw new HttpError(409, "device-offline");
    if (pendingHistory.size >= 20 || [...pendingHistory.values()].filter(value => value.deviceId === deviceId).length >= 4) throw new HttpError(429, "history-busy");
    const requestId = randomUUID();
    return new Promise<HistoryPage>((resolve, reject) => {
      const timer = setTimeout(() => { pendingHistory.delete(requestId); reject(new HttpError(504, "history-timeout")); }, 30000);
      pendingHistory.set(requestId, { deviceId, threadId, resolve, reject, timer });
      if (!send(agent.socket, { type: "history.request", requestId, threadId, cursor: cursor ?? null })) {
        clearTimeout(timer); pendingHistory.delete(requestId); reject(new HttpError(409, "device-offline"));
      }
    });
  });
  app.post("/v1/ws/tickets", { preHandler: member }, async request => queue.run(async () => {
    const principal = principals.get(request)!;
    if (!await store.sessionForHash(principal.sessionHash!)) throw new HttpError(401, "unauthorized");
    return store.ticket(principal);
  }));
  app.post<{ Params: { deviceId: string; threadId: string } }>("/v1/devices/:deviceId/threads/:threadId/images", { preHandler: deviceAccess, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async request => {
    const { deviceId, threadId } = z.object({ deviceId: idSchema, threadId: idSchema }).parse(request.params);
    if (!(await store.catalog(deviceId))?.threads.some(thread => thread.id === threadId)) throw new HttpError(404, "thread-not-in-catalog");
    let decoded;
    try { decoded = decodeImage(request.body); } catch { throw new HttpError(400, "invalid-image"); }
    const id = createHash("sha256").update(deviceId).update("\0").update(threadId).update("\0").update(decoded.bytes).digest("hex");
    try { await queue.run(async () => {
      if (!await store.ownsDevice(deviceId, principals.get(request)!)) throw new HttpError(404, "device-not-found");
      await store.saveImage(deviceId, threadId, id, decoded.image, true);
    }); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(413, "image-storage-full"); }
    return { id, name: decoded.image.name };
  });
  app.get<{ Params: { deviceId: string; threadId: string; imageId: string } }>("/v1/devices/:deviceId/threads/:threadId/images/:imageId", { preHandler: deviceAccess }, async (request, reply) => {
    const { deviceId, threadId, imageId } = z.object({ deviceId: idSchema, threadId: idSchema, imageId: imageIdSchema }).parse(request.params);
    if (!(await store.catalog(deviceId))?.threads.some(thread => thread.id === threadId)) throw new HttpError(404, "thread-not-in-catalog");
    let image = await store.image(deviceId, threadId, imageId);
    if (!image) {
      const agent = agents.get(deviceId);
      if (!agent || agent.socket.readyState !== WebSocket.OPEN) throw new HttpError(409, "device-offline");
      if (pendingImages.size >= 12 || [...pendingImages.values()].filter(value => value.deviceId === deviceId).length >= 4) throw new HttpError(429, "images-busy");
      const requestId = randomUUID();
      image = await new Promise<ImagePayload>((resolve, reject) => {
        const timer = setTimeout(() => { pendingImages.delete(requestId); reject(new HttpError(504, "image-timeout")); }, 15000);
        pendingImages.set(requestId, { deviceId, threadId, imageId, resolve, reject, timer });
        if (!send(agent.socket, { type: "image.request", requestId, threadId, imageId })) { clearTimeout(timer); pendingImages.delete(requestId); reject(new HttpError(409, "device-offline")); }
      });
    }
    if (!await store.ownsDevice(deviceId, principals.get(request)!)) throw new HttpError(404, "device-not-found");
    const { bytes } = decodeImage(image);
    return reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "default-src 'none'").type(image.mimeType).send(bytes);
  });
  app.get<{ Params: { deviceId: string } }>("/v1/agent/:deviceId/session", { preHandler: async request => {
    if (!await store.authorizeDevice(request.params.deviceId, bearer(request))) throw new HttpError(401, "unauthorized");
  } }, async () => ({ active: true }));
  app.get<{ Params: { deviceId: string; threadId: string; imageId: string } }>("/v1/agent/:deviceId/threads/:threadId/images/:imageId", { preHandler: async request => {
    const { deviceId } = request.params as { deviceId: string };
    if (!await store.authorizeDevice(deviceId, bearer(request))) throw new HttpError(401, "unauthorized");
  } }, async request => {
    const { deviceId, threadId, imageId } = z.object({ deviceId: idSchema, threadId: idSchema, imageId: imageIdSchema }).parse(request.params);
    const image = await store.image(deviceId, threadId, imageId, true);
    if (!image) throw new HttpError(404, "image-not-in-thread");
    return image;
  });
  app.post<{ Params: { deviceId: string } }>("/v1/devices/:deviceId/commands", { preHandler: deviceAccess }, async request => {
    const command = commandSchema.parse(request.body);
    if (command.deviceId !== request.params.deviceId) throw new HttpError(400, "device-mismatch");
    return queue.run(async () => {
      if (!await store.ownsDevice(command.deviceId, principals.get(request)!)) throw new HttpError(404, "device-not-found");
      return submit(command);
    });
  });
  app.get<{ Params: { deviceId: string; commandId: string } }>("/v1/devices/:deviceId/commands/:commandId", { preHandler: deviceAccess }, async request => {
    const command = await store.command(request.params.deviceId, request.params.commandId);
    if (!command) throw new HttpError(404, "command-not-found");
    return { status: command.status, result: command.result };
  });
  app.get("/v1/ws/device", {
    websocket: true,
    preValidation: async request => {
      if (!originAllowed(request)) throw new HttpError(403, "origin-denied");
      const id = request.headers["x-device-id"];
      const principal = typeof id === "string" ? await store.sessionPrincipal(bearer(request), id) : null;
      if (!principal) throw new HttpError(401, "unauthorized");
      principals.set(request, principal);
    },
  }, (socket, request) => {
    const deviceId = String(request.headers["x-device-id"]);
    const connection: AgentConnection = { socket, lastPong: Date.now(), principal: principals.get(request)! };
    socket.on("error", () => undefined);
    socket.on("pong", () => { connection.lastPong = Date.now(); });
    void queue.run(async () => {
      if (closing || socket.readyState !== WebSocket.OPEN || !await store.authorizeDevice(deviceId, bearer(request))) { socket.close(4003, "revoked"); return; }
      const previous = agents.get(deviceId);
      if (previous) failHistory(deviceId, 409, "connection-replaced");
      agents.set(deviceId, connection);
      previous?.socket.close(4001, "connection-replaced");
      await store.touch(deviceId);
      send(socket, { type: "device.welcome", deviceId, protocolVersion: PROTOCOL_VERSION, features: ["catalog", "history", "images"] });
      broadcast(deviceId, { type: "device.presence", deviceId, online: true });
    }).catch(() => socket.close(1011, "server-error"));
    socket.on("message", (bytes, binary) => {
      if (binary) { socket.close(1003, "text-required"); return; }
      let message: z.infer<typeof deviceMessageSchema>;
      // Normalize observation text before validation, broadcasting and JSONB persistence.
      // Control commands sent to the PC are not changed by this path.
      try { message = deviceMessageSchema.parse(JSON.parse(jsonForStorage(JSON.parse(bytes.toString())))); }
      catch { socket.close(1008, "invalid-message"); return; }
      void queue.run(async () => {
        if (agents.get(deviceId) !== connection) return;
        if (!await store.sessionForHash(connection.principal.sessionHash!, deviceId)) { socket.close(4003, "session-expired"); return; }
        if (message.type === "device.snapshot") {
          if (message.snapshot.deviceId !== deviceId) throw new Error("device-mismatch");
          await store.saveSnapshot(message.snapshot);
          broadcast(deviceId, message);
        } else if (message.type === "device.catalog") {
          if (message.catalog.deviceId !== deviceId) throw new Error("device-mismatch");
          await store.saveCatalog(message.catalog);
          broadcast(deviceId, { type: "catalog.updated", deviceId, generatedAt: message.catalog.generatedAt });
        } else if (message.type === "device.history") {
          const pending = pendingHistory.get(message.requestId);
          if (!pending || pending.deviceId !== deviceId || pending.threadId !== message.threadId) return;
          clearTimeout(pending.timer); pendingHistory.delete(message.requestId);
          if (message.page && message.page.threadId === message.threadId) pending.resolve(message.page);
          else pending.reject(new HttpError(502, message.code ?? "history-unavailable"));
        } else if (message.type === "device.image") {
          const pending = pendingImages.get(message.requestId);
          if (!pending || pending.deviceId !== deviceId || pending.threadId !== message.threadId || pending.imageId !== message.imageId) return;
          clearTimeout(pending.timer); pendingImages.delete(message.requestId);
          if (!message.image) { pending.reject(new HttpError(404, "image-unavailable")); return; }
          try {
            decodeImage(message.image);
            await store.saveImage(deviceId, message.threadId, message.imageId, message.image, false);
            pending.resolve(message.image);
          } catch { pending.reject(new HttpError(400, "invalid-image")); }
        } else if (message.type === "device.event") {
          if (message.event.deviceId !== deviceId) throw new Error("device-mismatch");
          try { await store.saveEvent(message.event); broadcast(deviceId, message); }
          catch { send(socket, { type: "device.resync", reason: "sequence-gap" }); }
        } else {
          if (message.result.deviceId !== deviceId) throw new Error("device-mismatch");
          if (await store.finishCommand(message.result)) broadcast(deviceId, message);
        }
      }).catch(error => {
        const reason = error instanceof Error ? error.message : '';
        if (reason === 'device-mismatch' || reason === 'stale-snapshot') socket.close(1008, reason);
        else {
          // Do not log SQL statements, payloads, identifiers or raw exception messages.
          const sqlState = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : undefined;
          console.warn(JSON.stringify({ type: 'relay.diagnostic', code: 'relay-storage-error', ...(sqlState ? { sqlState } : {}) }));
          socket.close(1011, "storage-error");
        }
      });
    });
    socket.on("close", () => { void queue.run(async () => {
      if (agents.get(deviceId) !== connection) return;
      agents.delete(deviceId);
      failHistory(deviceId, 409, "device-offline");
      await store.touch(deviceId);
      broadcast(deviceId, { type: "device.presence", deviceId, online: false });
    }).catch(() => undefined); });
  });
  app.get("/v1/ws/client", { websocket: true }, (socket, request) => {
    if (!originAllowed(request)) { socket.close(1008, "origin-denied"); return; }
    const client: ClientConnection = { socket, principal: null, devices: new Set(), lastPong: Date.now(), messages: 0, windowStart: Date.now(), authTimer: setTimeout(() => socket.close(1008, "authentication-required"), 5000) };
    clients.add(client);
    socket.on("error", () => undefined);
    socket.on("pong", () => { client.lastPong = Date.now(); });
    socket.on("close", () => { clearTimeout(client.authTimer); clients.delete(client); });
    socket.on("message", (bytes, binary) => {
      if (binary) { socket.close(1003, "text-required"); return; }
      if (Date.now() - client.windowStart > 60000) { client.messages = 0; client.windowStart = Date.now(); }
      if (++client.messages > 60) { socket.close(1008, "rate-limited"); return; }
      let message: z.infer<typeof clientMessageSchema>;
      try { message = clientMessageSchema.parse(JSON.parse(bytes.toString())); }
      catch { socket.close(1008, "invalid-message"); return; }
      void queue.run(async () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (message.type === "client.authenticate") {
          if (client.principal) { socket.close(1008, "invalid-ticket"); return; }
          const principal = await store.consumeTicket(message.ticket);
          if (!principal) { socket.close(1008, "invalid-ticket"); return; }
          clearTimeout(client.authTimer);
          client.principal = principal;
          send(socket, { type: "client.authenticated", protocolVersion: PROTOCOL_VERSION });
          return;
        }
        const principal = client.principal;
        if (!principal) { socket.close(1008, "authentication-required"); return; }
        if (!await store.sessionForHash(principal.sessionHash!)) { socket.close(4003, "session-expired"); return; }
        if (message.type === "client.command") {
          if (!await store.ownsDevice(message.command.deviceId, principal)) throw new HttpError(404, "device-not-found");
          send(socket, await submit(message.command)); return;
        }
        if (!await store.ownsDevice(message.deviceId, principal)) throw new HttpError(404, "device-not-found");
        const snapshot = await store.snapshot(message.deviceId);
        if (!snapshot) throw new HttpError(404, "snapshot-not-found");
        if (client.devices.size >= 20 && !client.devices.has(message.deviceId)) throw new HttpError(400, "subscription-limit");
        client.devices.add(message.deviceId);
        const events = message.epoch !== undefined && message.lastSeq !== undefined ? await store.replay(message.deviceId, message.epoch, message.lastSeq) : null;
        send(socket, { type: "sync.begin", deviceId: message.deviceId, epoch: snapshot.epoch, lastSeq: snapshot.lastSeq, mode: events === null ? "snapshot" : "replay" });
        if (events === null) send(socket, { type: "device.snapshot", snapshot });
        else for (const event of events) send(socket, { type: "device.event", event });
        send(socket, { type: "sync.ready", deviceId: message.deviceId, epoch: snapshot.epoch, lastSeq: snapshot.lastSeq });
        send(socket, { type: "device.presence", deviceId: message.deviceId, online: agents.has(message.deviceId) });
      }).catch(error => send(socket, { type: "error", code: error instanceof HttpError ? error.code : "server-error" }));
    });
  });
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const connection of [...agents.values(), ...clients]) {
      if (now - connection.lastPong > 45000) connection.socket.terminate();
      else if (connection.socket.readyState === WebSocket.OPEN) connection.socket.ping();
    }
    void queue.run(async () => { for (const client of clients) if (client.principal && !await store.sessionForHash(client.principal.sessionHash!)) client.socket.close(4003, "session-expired");
      for (const [id, agent] of agents) if (!await store.sessionForHash(agent.principal.sessionHash!, id)) closeSessions(value => value.sessionHash === agent.principal.sessionHash, "session-expired");
      for (const result of await store.expireCommands()) broadcast(result.deviceId, { type: "command.result", result }); }).catch(() => undefined);
  }, options.heartbeatMs ?? 15000);
  heartbeat.unref();
  const cleanup = setInterval(() => { void queue.run(() => store.cleanup()).catch(() => undefined); }, 3600000);
  cleanup.unref();
  app.addHook("preClose", async () => {
    closing = true;
    clearInterval(heartbeat); clearInterval(cleanup);
    for (const client of clients) { clearTimeout(client.authTimer); client.socket.terminate(); }
    for (const agent of agents.values()) agent.socket.terminate();
    for (const pending of pendingHistory.values()) { clearTimeout(pending.timer); pending.reject(new HttpError(503, "relay-closing")); }
    pendingHistory.clear();
    for (const pending of pendingImages.values()) { clearTimeout(pending.timer); pending.reject(new HttpError(503, "relay-closing")); }
    pendingImages.clear();
    await queue.run(async () => undefined);
  });
  app.addHook("onClose", async () => { await store.close(); });
  return app;
}
