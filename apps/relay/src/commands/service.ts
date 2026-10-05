import { WebSocket } from "ws";
import type { RemoteCommand } from "../../../../packages/protocol/src/index.js";
import { hash } from "../auth/hash.js";
import { HttpError } from "../core/errors.js";
import type { RelayStore } from "../storage/store.js";
import type { Connections } from "../transport/connections.js";

/** 先持久化幂等记录再转发；发送失败保留 unknown，避免盲目重试。 */
export function createCommandService(store: RelayStore, connections: Connections) {
  const { agents, send } = connections;

  async function submit(command: RemoteCommand): Promise<unknown> {
    const previous = await store.command(command.deviceId, command.commandId);
    if (previous) {
      if (previous.payload_hash !== hash(JSON.stringify(command)))
        throw new HttpError(409, "command-id-reused");
      return previous.result
        ? { type: "command.result", result: previous.result }
        : { type: "command.accepted", commandId: command.commandId };
    }
    if (command.expiresAt <= Date.now() || command.expiresAt > Date.now() + 300000)
      throw new HttpError(400, "invalid-command-expiry");
    const agent = agents.get(command.deviceId);
    if (!agent || agent.socket.readyState !== WebSocket.OPEN)
      throw new HttpError(409, "device-offline");
    const snapshot = await store.snapshotMetadata(command.deviceId);
    if (!snapshot || snapshot.epoch !== command.expectedEpoch)
      throw new HttpError(409, "stale-device-epoch");
    if (
      (command.payload.type === "turn.start" ||
        command.payload.type === "turn.queue" ||
        command.payload.type === "turn.steer") &&
      command.payload.images?.length
    ) {
      for (const id of command.payload.images)
        if (!(await store.image(command.deviceId, command.payload.threadId, id, true)))
          throw new HttpError(400, "image-not-in-thread");
      await store.retainImages(command.deviceId, command.payload.threadId, command.payload.images);
    }
    await store.addCommand(command);
    try {
      if (!send(agent.socket, { type: "command", command })) throw new Error("dispatch-failed");
    } catch {
      const result = {
        deviceId: command.deviceId,
        commandId: command.commandId,
        status: "unknown" as const,
        code: "dispatch-unconfirmed",
      };
      await store.finishCommand(result);
      return { type: "command.result", result };
    }
    return { type: "command.accepted", commandId: command.commandId };
  }

  return { submit };
}
