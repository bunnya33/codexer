import { PROTOCOL_VERSION } from "../../../../packages/protocol/src/index.js";
import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 服务健康检查。 */
export function registerCoreHealth(app: FastifyInstance, context: RelayContext): void {
  const options = context.options;

  app.get("/health", async () => ({
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    version: options.version ?? "development",
  }));
}
