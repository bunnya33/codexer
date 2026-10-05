import { z } from "zod";
import { HttpError } from "../core/errors.js";
import { loginSchema } from "../auth/schemas.js";
import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 登录、会话与一次性 WebSocket 票据。 */
export function registerAuthRoutes(app: FastifyInstance, context: RelayContext): void {
  const agents = context.connections.agents;
  const store = context.store;
  const queue = context.queue;
  const closeSessions = context.connections.closeSessions;
  const login = context.login;
  const principals = context.guards.principals;
  const member = context.guards.member;
  const control = context.guards.control;
  const originAllowed = context.guards.originAllowed;

  const loginOptions = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post("/v1/admin/auth/login", loginOptions, async (request) => {
    if (!originAllowed(request)) throw new HttpError(403, "origin-denied");
    const { username, password } = loginSchema.parse(request.body);
    return queue.run(async () => {
      const account = await login(username, password, "admin");
      return {
        ...(await store.createSession(account.id)),
        role: account.kind,
        userId: account.id,
        username,
      };
    });
  });

  app.post("/v1/auth/login", loginOptions, async (request) => {
    if (!originAllowed(request)) throw new HttpError(403, "origin-denied");
    const { username, password } = loginSchema.parse(request.body);
    return queue.run(async () => {
      const account = await login(username, password);
      return {
        ...(await store.createSession(account.id)),
        role: account.kind,
        userId: account.id,
        username,
      };
    });
  });

  app.post("/v1/auth/logout", { preHandler: member }, async (request) =>
    queue.run(async () => {
      const principal = principals.get(request)!;
      await store.logout(principal.sessionHash!);
      closeSessions((value) => value.sessionHash === principal.sessionHash, "logged-out");
      return { loggedOut: true };
    }),
  );

  app.get("/v1/me", { preHandler: member }, async (request) => {
    const principal = principals.get(request)!;
    return { role: principal.kind, userId: principal.id };
  });

  app.post("/v1/auth/active", { preHandler: member }, async (request) =>
    queue.run(async () => {
      const result = await store.touchSession(principals.get(request)!.sessionHash!);
      if (!result) throw new HttpError(401, "unauthorized");
      return result;
    }),
  );

  app.post("/v1/ws/tickets", { preHandler: control }, async (request) =>
    queue.run(async () => {
      const principal = principals.get(request)!;
      if (!(await store.sessionForHash(principal.sessionHash!)))
        throw new HttpError(401, "unauthorized");
      return store.ticket(principal);
    }),
  );
  app.post("/v1/agents/login", loginOptions, async (request) => {
    if (!originAllowed(request)) throw new HttpError(403, "origin-denied");
    const body = loginSchema
      .extend({
        installationId: z.string().uuid(),
        name: z.string().trim().min(1).max(200),
        platform: z.enum(["win32", "darwin", "linux"]),
      })
      .parse(request.body);
    return queue.run(async () => {
      const account = await login(body.username, body.password);
      const deviceId = await store.registerAgent(
        account.id,
        body.installationId,
        body.name,
        body.platform,
      );
      const previous = agents.get(deviceId);
      if (previous)
        closeSessions(
          (value) => value.sessionHash === previous.principal.sessionHash,
          "agent-login-replaced",
        );
      return { ...(await store.createSession(account.id, deviceId)), deviceId, userId: account.id };
    });
  });
}
