import { z } from "zod";
import { HttpError } from "../core/errors.js";
import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 受限更新器的版本、准备、构建与重启接口。 */
export function registerUpdatesRoutes(app: FastifyInstance, context: RelayContext): void {
  const options = context.options;
  const admin = context.guards.admin;

  app.get("/v1/admin/system/version", { preHandler: admin }, async (request) => {
    if (!options.updates) throw new HttpError(503, "updates-unavailable");
    return options.updates.info((request.query as { force?: string }).force === "true");
  });

  app.post("/v1/admin/system/update", { preHandler: admin }, async (request) => {
    if (!options.updates) throw new HttpError(503, "updates-unavailable");
    const { tag, action, jobId } = z
      .object({
        tag: z.string().regex(/^v\d+\.\d+\.\d+$/),
        action: z.enum(["update", "build", "restart"]).default("update"),
        jobId: z.uuid().optional(),
      })
      .strict()
      .parse(request.body);
    try {
      return await options.updates.request(tag, action, jobId);
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : "update-unavailable");
    }
  });

  app.put("/v1/admin/system/update-settings", { preHandler: admin }, async (request) => {
    if (!options.updates) throw new HttpError(503, "updates-unavailable");
    const settings = z
      .object({
        autoInstall: z.boolean().optional(),
        method: z.enum(["release", "git"]).optional(),
      })
      .strict()
      .refine((value) => value.autoInstall !== undefined || value.method !== undefined)
      .parse(request.body);
    try {
      return await options.updates.setSettings(settings);
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : "updater-not-installed");
    }
  });
}
