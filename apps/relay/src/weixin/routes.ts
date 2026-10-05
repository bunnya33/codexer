import { z } from "zod";
import { WeixinError } from "../weixin/api.js";
import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 微信绑定、配置与测试接口。 */
export function registerWeixinRoutes(app: FastifyInstance, context: RelayContext): void {
  const weixin = context.weixin;
  const principals = context.guards.principals;
  const control = context.guards.control;

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
    return weixinRequired().settings(principals.get(request)!.id, body.notifications, body.replies);
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
