import { z } from "zod";
import { WeixinError } from "../weixin/api.js";
import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";
import { idSchema } from "../../../../packages/protocol/src/index.js";
import { HttpError } from "../core/errors.js";

/** 微信绑定、配置与测试接口。 */
export function registerWeixinRoutes(app: FastifyInstance, context: RelayContext): void {
  const weixin = context.weixin;
  const principals = context.guards.principals;
  const control = context.guards.control;
  const { store, queue } = context;

  const threadView = async (userId: string, deviceId: string, threadId: string) => {
    const binding = await store.weixin.get(userId);
    return {
      enabled: await store.weixin.threadNotifications(userId, deviceId, threadId),
      allEnabled: binding?.notifications ?? false,
      available: !!weixin,
      bound: !!binding,
    };
  };

  for (const method of ["GET", "PUT"] as const)
    app.route({
      method,
      url: "/v1/devices/:deviceId/threads/:threadId/weixin-notification",
      preHandler: control,
      handler: async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const { deviceId, threadId } = z
          .object({ deviceId: idSchema, threadId: idSchema })
          .parse(request.params);
        const enabled =
          method === "PUT"
            ? z.object({ enabled: z.boolean() }).strict().parse(request.body).enabled
            : undefined;
        return queue.runDevice(deviceId, async () => {
          const principal = principals.get(request)!;
          if (!(await store.ownsDevice(deviceId, principal)))
            throw new HttpError(404, "device-not-found");
          if (
            !(await store.catalog(deviceId))?.threads.some(
              (thread) => thread.id === threadId && !thread.archived,
            )
          )
            throw new HttpError(404, "thread-not-in-catalog");
          if (enabled !== undefined)
            await store.weixin.setThreadNotifications(principal.id, deviceId, threadId, enabled);
          const notification = await threadView(principal.id, deviceId, threadId);
          if (enabled !== undefined)
            context.connections.broadcastAccount(principal.id, {
              type: "weixin.thread-notification",
              deviceId,
              threadId,
              notification,
            });
          return notification;
        });
      },
    });

  const weixinRequired = () => {
    if (!weixin) throw new WeixinError("weixin-disabled", 503);
    return weixin;
  };

  app.get("/v1/weixin", { preHandler: control }, async (request) =>
    weixin
      ? weixin.status(principals.get(request)!.id)
      : {
          available: false,
          bound: false,
          connected: false,
          activated: false,
          notifications: true,
          replies: true,
          lastError: null,
          pendingNotifications: 0,
        },
  );

  app.post(
    "/v1/weixin/login",
    { preHandler: control, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request) => weixinRequired().startLogin(principals.get(request)!.id),
  );

  app.post<{ Params: { loginId: string } }>(
    "/v1/weixin/login/:loginId/poll",
    { preHandler: control },
    async (request) => {
      const body = z
        .object({
          verifyCode: z
            .string()
            .trim()
            .regex(/^[a-zA-Z0-9]{1,16}$/)
            .optional(),
        })
        .strict()
        .parse(request.body ?? {});
      return weixinRequired().pollLogin(
        principals.get(request)!.id,
        z.string().uuid().parse(request.params.loginId),
        body.verifyCode,
      );
    },
  );

  app.put("/v1/weixin", { preHandler: control }, async (request) => {
    const body = z
      .object({ notifications: z.boolean(), replies: z.boolean() })
      .strict()
      .parse(request.body);
    return queue.run(async () => {
      const userId = principals.get(request)!.id;
      const status = await weixinRequired().settings(userId, body.notifications, body.replies);
      context.connections.broadcastAccount(userId, { type: "weixin.settings", status });
      return status;
    });
  });

  app.delete("/v1/weixin", { preHandler: control }, async (request) => {
    await weixinRequired().unbind(principals.get(request)!.id);
    return { unbound: true };
  });

  app.post(
    "/v1/weixin/test",
    { preHandler: control, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request) => weixinRequired().test(principals.get(request)!.id),
  );
}
