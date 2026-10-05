import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "./errors.js";
import { WeixinError } from "../weixin/api.js";
import type { RelayContext } from "./context.js";

/** HTTP 公共策略：同源静态资源、允许的跨域来源和稳定错误码。 */
export async function registerHttp(app: FastifyInstance, context: RelayContext): Promise<void> {
  const { options } = context;
  const { originAllowed } = context.guards;
  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, { root: options.webRoot, prefix: "/", index: "index.html" });
  }

  if (options.adminRoot && existsSync(options.adminRoot)) {
    await app.register(fastifyStatic, {
      root: options.adminRoot,
      prefix: "/admin/",
      index: "index.html",
      decorateReply: !options.webRoot || !existsSync(options.webRoot),
    });
    app.get("/admin", async (_request, reply) => reply.redirect("/admin/"));
  }

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/v1/weixin")) reply.header("Cache-Control", "no-store");
    const origin = request.headers.origin;
    if (origin && originAllowed(request)) {
      reply.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    }
  });

  app.options("/v1/*", async (request, reply) => {
    if (!request.headers.origin || !originAllowed(request))
      return reply.code(403).send({ error: "origin-denied" });
    return reply.code(204).send();
  });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error instanceof HttpError || error instanceof WeixinError
        ? error.statusCode
        : error instanceof z.ZodError
          ? 400
          : error !== null &&
              typeof error === "object" &&
              "statusCode" in error &&
              typeof error.statusCode === "number" &&
              error.statusCode >= 400 &&
              error.statusCode <= 599
            ? error.statusCode
            : 500;
    void reply.code(statusCode).send({
      error:
        error instanceof HttpError || error instanceof WeixinError
          ? error.code
          : statusCode === 400
            ? "invalid-request"
            : statusCode === 413
              ? "request-too-large"
              : statusCode === 429
                ? "rate-limited"
                : "server-error",
    });
  });
}
