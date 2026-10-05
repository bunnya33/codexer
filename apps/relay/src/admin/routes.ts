import { z } from "zod";
import { authSettingsSchema } from "../../../../packages/shared/src/session-policy.js";
import { HttpError } from "../core/errors.js";
import { loginSchema } from "../auth/schemas.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 管理员账号管理与服务概览；不授予设备控制权。 */
export function registerAdminRoutes(app: FastifyInstance, context: RelayContext): void {
  const store = context.store;
  const queue = context.queue;
  const agents = context.connections.agents;
  const clients = context.connections.clients;
  const closeSessions = context.connections.closeSessions;
  const principals = context.guards.principals;
  const admin = context.guards.admin;
  const runAdmin = <T>(request: FastifyRequest, operation: () => Promise<T>) =>
    queue.run(async () => {
      // preHandler 与排队执行之间可能发生管理员撤销，执行前重新验证。
      if (!(await store.sessionForHash(principals.get(request)!.sessionHash!)))
        throw new HttpError(401, "unauthorized");
      return operation();
    });

  app.get("/v1/admin/auth-settings", { preHandler: admin }, async () => store.authSettings());

  app.put("/v1/admin/auth-settings", { preHandler: admin }, async (request) => {
    const settings = authSettingsSchema.parse(request.body);
    return runAdmin(request, () => store.setAuthSettings(settings));
  });

  app.post("/v1/users", { preHandler: admin }, async (request) => {
    const { username, password } = loginSchema
      .extend({ password: z.string().min(12).max(128) })
      .parse(request.body);
    try {
      return await runAdmin(request, () => store.createUser(username, password));
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new HttpError(409, "account-name-taken");
      throw error;
    }
  });

  app.get("/v1/users", { preHandler: admin }, async () => ({
    users: await store.listUsers("user"),
  }));

  app.get("/v1/admin/accounts", { preHandler: admin }, async (request) => ({
    users: await store.listUsers("admin"),
    currentUserId: principals.get(request)!.id,
  }));

  app.post("/v1/admin/accounts", { preHandler: admin }, async (request) => {
    const { username, password } = loginSchema
      .extend({ password: z.string().min(12).max(128) })
      .parse(request.body);
    try {
      return await runAdmin(request, () => store.createUser(username, password, "admin"));
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new HttpError(409, "account-name-taken");
      throw error;
    }
  });

  app.put<{ Params: { userId: string } }>(
    "/v1/admin/accounts/:userId/password",
    { preHandler: admin },
    async (request) => {
      const { password } = z.object({ password: z.string().min(12).max(128) }).parse(request.body);
      return runAdmin(request, async () => {
        if (!(await store.resetPassword(request.params.userId, password, "admin")))
          throw new HttpError(404, "admin-not-found");
        closeSessions((value) => value.id === request.params.userId, "password-reset");
        return { reset: true };
      });
    },
  );

  app.delete<{ Params: { userId: string } }>(
    "/v1/admin/accounts/:userId",
    { preHandler: admin },
    async (request) =>
      runAdmin(request, async () => {
        try {
          if (
            !(await store.revokeUser(request.params.userId, "admin", principals.get(request)!.id))
          )
            throw new HttpError(404, "admin-not-found");
        } catch (error) {
          if (error instanceof Error && error.message === "admin-disable-protected")
            throw new HttpError(409, "admin-disable-protected");
          throw error;
        }
        closeSessions((value) => value.id === request.params.userId, "account-disabled");
        return { revoked: true };
      }),
  );

  app.get("/v1/admin/overview", { preHandler: admin }, async () => {
    const users = await store.listUsers("user"),
      admins = await store.listUsers("admin");
    const enabled = (rows: typeof users) =>
      rows.filter((u) => !u.revoked_at && u.login_enabled).length;
    return {
      users: users.length,
      enabledUsers: enabled(users),
      admins: admins.length,
      enabledAdmins: enabled(admins),
      onlineDevices: agents.size,
      onlineClients: [...clients].filter((c) => c.principal).length,
      uptime: Math.floor(process.uptime()),
    };
  });

  app.delete<{ Params: { userId: string } }>(
    "/v1/users/:userId",
    { preHandler: admin },
    async (request) =>
      runAdmin(request, async () => {
        if (!(await store.revokeUser(request.params.userId)))
          throw new HttpError(404, "user-not-found-or-admin");
        closeSessions((value) => value.id === request.params.userId, "account-disabled");
        return { revoked: true };
      }),
  );

  app.put<{ Params: { userId: string } }>(
    "/v1/users/:userId/password",
    { preHandler: admin },
    async (request) => {
      const { password } = z.object({ password: z.string().min(12).max(128) }).parse(request.body);
      return runAdmin(request, async () => {
        if (!(await store.resetPassword(request.params.userId, password)))
          throw new HttpError(404, "user-not-found");
        closeSessions((value) => value.id === request.params.userId, "password-reset");
        return { reset: true };
      });
    },
  );
}
