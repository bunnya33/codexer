import { WebSocket } from "ws";
import { MAX_MESSAGE_BYTES } from "../../../../packages/protocol/src/index.js";
import type { HistoryPage } from "../../../../packages/protocol/src/index.js";
import type { ImagePayload } from "../../../../packages/protocol/src/index.js";
import type { FilePayload } from "../../../../packages/protocol/src/files.js";
import type { PreviewResponse } from "../../../../packages/protocol/src/previews.js";
import type { Principal } from "../auth/types.js";
import { HttpError } from "../core/errors.js";
import { performance } from "node:perf_hooks";
import type { RelayMetrics } from "../observability/metrics.js";

export type AgentConnection = {
  socket: WebSocket;
  lastPong: number;
  principal: Principal;
  filesSupported?: boolean;
  previewsSupported?: boolean;
};

export type ClientConnection = {
  socket: WebSocket;
  principal: Principal | null;
  devices: Set<string>;
  lastPong: number;
  messages: number;
  windowStart: number;
  authTimer: NodeJS.Timeout;
  pending?: Promise<unknown>;
};

type PendingHistory = {
  deviceId: string;
  threadId: string;
  resolve: (page: HistoryPage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingImage = {
  deviceId: string;
  threadId: string;
  imageId: string;
  resolve: (image: ImagePayload) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingFile = {
  deviceId: string;
  threadId: string;
  path: string;
  offset?: number;
  version?: string;
  resolve: (file: FilePayload) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** 仅维护当前进程的连接、订阅与待回源请求；在线状态不从快照推断。 */
export function createConnections(metrics?: RelayMetrics) {
  const agents = new Map<string, AgentConnection>();
  const clients = new Set<ClientConnection>();
  const pendingHistory = new Map<string, PendingHistory>();
  const pendingImages = new Map<string, PendingImage>();
  const pendingFiles = new Map<string, PendingFile>();
  const pendingPreviews = new Map<
    string,
    {
      deviceId: string;
      principal: Principal;
      token: string;
      accept: (message: PreviewResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  const subscribers = new Map<string, Set<ClientConnection>>();

  function send(socket: WebSocket, message: unknown): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const json = JSON.stringify(message);
    return sendSerialized(socket, json, Buffer.byteLength(json));
  }

  function sendSerialized(socket: WebSocket, json: string, bytes: number): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 16 * 1024 * 1024) {
      metrics?.observeClose("backpressure");
      socket.close(1013, "backpressure");
      return false;
    }
    if (bytes > MAX_MESSAGE_BYTES) {
      metrics?.observeClose("payload-too-large");
      socket.close(1009, "payload-too-large");
      return false;
    }
    socket.send(json);
    metrics?.observeSend(bytes);
    return true;
  }

  function broadcast(deviceId: string, message: unknown): void {
    const targets = subscribers.get(deviceId);
    if (!targets?.size) return;
    const startedAt = performance.now();
    const json = JSON.stringify(message);
    const bytes = Buffer.byteLength(json);
    let recipients = 0;
    for (const client of targets) {
      if (client.principal && sendSerialized(client.socket, json, bytes)) recipients++;
    }
    metrics?.observeBroadcast(performance.now() - startedAt, recipients);
  }

  function broadcastAccount(userId: string, message: unknown): void {
    for (const client of clients)
      if (client.principal?.kind === "user" && client.principal.id === userId)
        send(client.socket, message);
  }

  /** 正反索引同时更新，断开或撤销时不残留订阅。 */
  function subscribe(client: ClientConnection, deviceId: string): boolean {
    // 同步读取期间客户端可能断开；禁止把已经移除的连接重新放回索引。
    if (!clients.has(client) || !client.principal || client.socket.readyState !== WebSocket.OPEN)
      return false;
    client.devices.add(deviceId);
    let targets = subscribers.get(deviceId);
    if (!targets) {
      targets = new Set();
      subscribers.set(deviceId, targets);
    }
    targets.add(client);
    return true;
  }

  function removeClient(client: ClientConnection): void {
    clients.delete(client);
    for (const deviceId of client.devices) {
      const targets = subscribers.get(deviceId);
      targets?.delete(client);
      if (!targets?.size) subscribers.delete(deviceId);
    }
    client.devices.clear();
  }

  function failHistory(deviceId: string, status: number, code: string): void {
    for (const [id, pending] of pendingPreviews)
      if (pending.deviceId === deviceId) {
        pendingPreviews.delete(id);
        pending.reject(new HttpError(status, code));
      }
    for (const [id, pending] of pendingFiles)
      if (pending.deviceId === deviceId) {
        clearTimeout(pending.timer);
        pendingFiles.delete(id);
        pending.reject(new HttpError(status, code));
      }
    for (const [id, pending] of pendingHistory)
      if (pending.deviceId === deviceId) {
        clearTimeout(pending.timer);
        pendingHistory.delete(id);
        pending.reject(new HttpError(status, code));
      }
    for (const [id, pending] of pendingImages)
      if (pending.deviceId === deviceId) {
        clearTimeout(pending.timer);
        pendingImages.delete(id);
        pending.reject(new HttpError(status, code));
      }
  }

  function closeSessions(matches: (principal: Principal) => boolean, reason: string) {
    for (const [id, pending] of pendingPreviews)
      if (matches(pending.principal)) {
        pendingPreviews.delete(id);
        pending.reject(new HttpError(401, reason));
      }
    for (const client of clients)
      if (client.principal && matches(client.principal)) {
        removeClient(client);
        client.socket.close(4003, reason);
      }
    for (const [id, agent] of agents)
      if (matches(agent.principal)) {
        agents.delete(id);
        agent.socket.close(4003, reason);
        failHistory(id, 401, reason);
        broadcast(id, { type: "device.presence", deviceId: id, online: false });
      }
  }

  return {
    agents,
    clients,
    pendingHistory,
    pendingImages,
    pendingFiles,
    pendingPreviews,
    send,
    broadcast,
    broadcastAccount,
    subscribe,
    removeClient,
    failRequests: failHistory,
    closeSessions,
    snapshot: () => {
      let bufferedBytes = 0;
      let maxBufferedBytes = 0;
      for (const connection of [...agents.values(), ...clients]) {
        bufferedBytes += connection.socket.bufferedAmount;
        maxBufferedBytes = Math.max(maxBufferedBytes, connection.socket.bufferedAmount);
      }
      return {
        onlineDevices: agents.size,
        onlineClients: [...clients].filter((client) => client.principal).length,
        pendingHistory: pendingHistory.size,
        pendingImages: pendingImages.size,
        pendingFiles: pendingFiles.size,
        subscriptionDevices: subscribers.size,
        subscriptions: [...subscribers.values()].reduce(
          (total, targets) => total + targets.size,
          0,
        ),
        bufferedBytes,
        maxBufferedBytes,
      };
    },
  };
}

export type Connections = ReturnType<typeof createConnections>;
