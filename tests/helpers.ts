import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { encodeFrame, FrameDecoder } from "../packages/codex-adapter/src/framing.js";
import { normalizeThread, record } from "../packages/codex-adapter/src/normalize.js";
import type { RecordValue } from "../packages/codex-adapter/src/normalize.js";
import type { DeviceSnapshot, RemoteCommand, RemoteEvent } from "../packages/protocol/src/index.js";

export function rawThread(status = "active"): RecordValue {
  return {
    id: "thread-test", title: "Test", cwd: "/test", updatedAt: 123,
    threadRuntimeStatus: { type: status, activeFlags: [] }, requests: [], turns: [],
    turnHistory: { kind: "canonical", history: {
      islands: [{ entries: [{ value: "turn-key" }] }],
      entitiesByKey: { "turn-key": { turnId: "turn-A", status: "inProgress", items: [], diff: "" } },
    } },
  };
}
export function snapshot(deviceId = "device-test", epoch = "epoch-test"): DeviceSnapshot {
  return {
    protocolVersion: 1, deviceId, epoch, lastSeq: 0, generatedAt: Date.now(), hostname: "test-pc", platform: "win32",
    runtime: { kind: "official-desktop-ipc", connected: true, experimental: true, capabilities: { observe: true, startTurn: true, interrupt: true, approvals: true, userInput: true } },
    threads: { "thread-test": normalizeThread(rawThread(), 0) },
  };
}
export function event(state: DeviceSnapshot, connected = false): RemoteEvent {
  return { protocolVersion: 1, deviceId: state.deviceId, epoch: state.epoch, seq: state.lastSeq + 1, timestamp: Date.now(), change: { type: "runtime.status", connected } };
}
export function command(payload: RemoteCommand["payload"], state = snapshot()): RemoteCommand {
  return { commandId: randomUUID(), deviceId: state.deviceId, expectedEpoch: state.epoch, expiresAt: Date.now() + 60000, payload };
}
export async function waitFor(test: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!await test()) {
    if (Date.now() - start > timeout) throw new Error("condition-timeout");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

export class FakeDesktop {
  readonly endpoint = process.platform === "win32" ? `\\\\.\\pipe\\codex-remote-test-${randomUUID()}` : join(tmpdir(), `cr-${randomUUID()}.sock`);
  readonly ownerId = "official-owner-test";
  readonly received: RecordValue[] = [];
  state = rawThread();
  revision = 0;
  autoSnapshot = true;
  response?: (message: RecordValue) => unknown;
  private readonly clients = new Map<Socket, { id: string; following: boolean }>();
  private readonly server: Server = createServer(socket => {
    const client = { id: randomUUID(), following: false };
    this.clients.set(socket, client);
    const decoder = new FrameDecoder();
    socket.on("error", () => undefined);
    socket.on("close", () => this.clients.delete(socket));
    socket.on("data", bytes => {
      for (const value of decoder.push(bytes)) {
        const message = record(value), params = record(message.params);
        this.received.push(message);
        if (message.type === "broadcast") {
          if (message.method === "thread-stream-following-changed" && params.conversationId === this.state.id) {
            client.following = params.following === true;
            if (client.following && this.autoSnapshot) this.sendSnapshot(socket);
          }
          continue;
        }
        if (message.type !== "request") continue;
        let result: unknown;
        if (message.method === "initialize") result = { clientId: client.id };
        else if (message.method === "thread-owner-discovery" && params.conversationId === this.state.id) result = { supportsUntrustedAppInput: true };
        else if (String(message.method).startsWith("thread-follower-")) {
          result = this.response?.(message) ?? (message.method === "thread-follower-start-turn" ? { result: { turn: { id: "turn-new" } } } : message.method === "thread-follower-steer-turn" ? { result: { turnId: "turn-A" } } : message.method === "thread-follower-load-complete-history" ? { revision: this.revision } : message.method === "thread-follower-interrupt-turn" ? { ok: true, interruptedTurnId: params.expectedTurnId === "turn-A" ? "turn-A" : null } : { ok: true });
        } else {
          socket.write(encodeFrame({ type: "response", requestId: message.requestId, resultType: "error", error: "no-client-found" }));
          continue;
        }
        socket.write(encodeFrame({ type: "response", requestId: message.requestId, resultType: "success", handledByClientId: this.ownerId, result }));
      }
    });
  });
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.endpoint, resolve); });
  }
  private sendSnapshot(socket: Socket, version = 11): void {
    socket.write(encodeFrame({ type: "broadcast", sourceClientId: this.ownerId, method: "thread-stream-state-changed", version,
      params: { hostId: "local", conversationId: this.state.id, change: { type: "snapshot", revision: this.revision, conversationState: this.state } } }));
  }
  publishSnapshot(version = 11): void { for (const [socket, client] of this.clients) if (client.following) this.sendSnapshot(socket, version); }
  publishPatches(patches: unknown[], baseRevision = this.revision): void {
    const revision = ++this.revision;
    for (const [socket, client] of this.clients) if (client.following) socket.write(encodeFrame({ type: "broadcast", sourceClientId: this.ownerId, method: "thread-stream-state-changed", version: 11,
      params: { hostId: "local", conversationId: this.state.id, change: { type: "patches", patches, baseRevision, revision } } }));
  }
  disconnectClients(): void { for (const socket of this.clients.keys()) socket.destroy(); }
  async close(): Promise<void> {
    this.disconnectClients();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
}

export class WsPeer {
  readonly socket: WebSocket;
  readonly messages: RecordValue[] = [];
  readonly closed: Promise<number>;
  private constructor(url: string, headers?: Record<string, string>) {
    this.socket = new WebSocket(url, { headers, perMessageDeflate: false });
    this.closed = new Promise(resolve => this.socket.once("close", resolve));
    this.socket.on("error", () => undefined);
    this.socket.on("message", bytes => { this.messages.push(record(JSON.parse(bytes.toString()))); });
  }
  static async open(url: string, headers?: Record<string, string>): Promise<WsPeer> {
    const peer = new WsPeer(url, headers);
    await new Promise<void>((resolve, reject) => { peer.socket.once("open", resolve); peer.socket.once("error", reject); });
    return peer;
  }
  send(message: unknown): void { this.socket.send(JSON.stringify(message)); }
  async wait(predicate: (message: RecordValue) => boolean, timeout = 5000): Promise<RecordValue> {
    await waitFor(() => this.messages.some(predicate), timeout);
    return this.messages.find(predicate)!;
  }
  async close(): Promise<void> { this.socket.close(); await this.closed; }
}
