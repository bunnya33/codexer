import { WebSocket } from "ws";
import { commandSchema } from "../../../../packages/protocol/src/index.js";
import { WeixinError } from "../weixin/api.js";
import { WeixinService } from "../weixin/service.js";
import { HttpError } from "../core/errors.js";
import type { RelayContext } from "../core/context.js";

/** 微信指令走与 HTTP/WS 相同的权限与命令幂等路径。 */
export function createWeixinService(context: RelayContext): WeixinService | undefined {
  const store = context.store;
  const queue = context.queue;
  const options = context.options;
  const agents = context.connections.agents;
  const submit = context.commands.submit;
  const weixin = options.weixin
    ? new WeixinService(
        store,
        options.weixin,
        (userId, bindingId, command) =>
          queue.runDevice(command.deviceId, async () => {
            if (context.closing || !(await store.weixin.current(bindingId, userId)))
              throw new WeixinError("weixin-account-inactive", 403);
            if (!(await store.ownsDevice(command.deviceId, { id: userId, kind: "user" })))
              throw new HttpError(404, "device-not-found");
            const binding = await store.weixin.get(userId);
            if (!binding?.replies) throw new WeixinError("weixin-replies-disabled", 403);
            if ("threadId" in command.payload) {
              const threadId = command.payload.threadId;
              const catalog = await store.catalog(command.deviceId);
              if (!catalog?.threads.some((t) => t.id === threadId && !t.archived))
                throw new WeixinError("weixin-target-not-found", 404);
            }
            return submit(commandSchema.parse(command));
          }),
        (deviceId) => agents.get(deviceId)?.socket.readyState === WebSocket.OPEN,
      )
    : undefined;

  return weixin;
}
