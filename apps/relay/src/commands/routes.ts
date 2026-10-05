import { commandSchema } from "../../../../packages/protocol/src/index.js";
import { HttpError } from "../core/errors.js";
import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 命令提交与结果查询。 */
export function registerCommandsRoutes(app: FastifyInstance, context: RelayContext): void {
  const store = context.store;
  const queue = context.queue;
  const submit = context.commands.submit;
  const principals = context.guards.principals;
  const deviceAccess = context.guards.deviceAccess;

  app.post<{ Params: { deviceId: string } }>(
    "/v1/devices/:deviceId/commands",
    { preHandler: deviceAccess },
    async (request) => {
      const command = commandSchema.parse(request.body);
      if (command.deviceId !== request.params.deviceId) throw new HttpError(400, "device-mismatch");
      return queue.runDevice(command.deviceId, async () => {
        if (!(await store.ownsDevice(command.deviceId, principals.get(request)!)))
          throw new HttpError(404, "device-not-found");
        return submit(command);
      });
    },
  );

  app.get<{ Params: { deviceId: string; commandId: string } }>(
    "/v1/devices/:deviceId/commands/:commandId",
    { preHandler: deviceAccess },
    async (request) => {
      const command = await store.command(request.params.deviceId, request.params.commandId);
      if (!command) throw new HttpError(404, "command-not-found");
      return { status: command.status, result: command.result };
    },
  );
}
