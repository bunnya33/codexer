import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { MAX_MESSAGE_BYTES } from "../packages/protocol/src/index.js";
import { createConnections } from "../apps/relay/src/transport/connections.js";
import type { ClientConnection } from "../apps/relay/src/transport/connections.js";
import { RelayMetrics } from "../apps/relay/src/observability/metrics.js";

function fakeClient(bufferedAmount = 0) {
  const socket = { readyState: WebSocket.OPEN, bufferedAmount, send: vi.fn(), close: vi.fn() };
  const client: ClientConnection = {
    socket: socket as unknown as WebSocket,
    principal: { id: "test-user", kind: "user" },
    devices: new Set(),
    lastPong: 0,
    messages: 0,
    windowStart: 0,
    authTimer: undefined as unknown as NodeJS.Timeout,
  };
  return { client, socket };
}

describe("indexed device broadcast", () => {
  it("serializes once for all subscribers and never visits unrelated device subscriptions", () => {
    const metrics = new RelayMetrics();
    const connections = createConnections(metrics);
    const a = fakeClient(),
      b = fakeClient(),
      other = fakeClient();
    for (const { client } of [a, b, other]) connections.clients.add(client);
    connections.subscribe(a.client, "device-a");
    connections.subscribe(b.client, "device-a");
    connections.subscribe(other.client, "device-b");
    Object.defineProperty(other.client, "devices", {
      get: () => {
        throw new Error("unrelated-client-scan");
      },
    });
    let serializations = 0;
    const payload = {
      toJSON: () => {
        serializations++;
        return { type: "test" };
      },
    };
    connections.broadcast("device-a", payload);
    expect(serializations).toBe(1);
    expect(a.socket.send).toHaveBeenCalledWith('{"type":"test"}');
    expect(b.socket.send).toHaveBeenCalledWith('{"type":"test"}');
    expect(other.socket.send).not.toHaveBeenCalled();
    expect(metrics.snapshot().transport.broadcastRecipients).toBe(2);
  });

  it("removes both subscription indexes on disconnect and refuses late subscriptions", () => {
    const connections = createConnections();
    const a = fakeClient();
    connections.clients.add(a.client);
    expect(connections.subscribe(a.client, "device-a")).toBe(true);
    connections.subscribe(a.client, "device-a");
    connections.subscribe(a.client, "device-b");
    expect(connections.snapshot().subscriptions).toBe(2);
    connections.removeClient(a.client);
    expect(connections.snapshot()).toMatchObject({
      subscriptions: 0,
      subscriptionDevices: 0,
      onlineClients: 0,
    });
    expect(connections.subscribe(a.client, "device-a")).toBe(false);
    connections.broadcast("device-a", { type: "test" });
    expect(a.socket.send).not.toHaveBeenCalled();
  });

  it("closes a slow subscriber while delivering to other subscribers and counts rejected payloads", () => {
    const metrics = new RelayMetrics();
    const connections = createConnections(metrics);
    const slow = fakeClient(17 * 1024 * 1024),
      fast = fakeClient();
    for (const { client } of [slow, fast]) {
      connections.clients.add(client);
      connections.subscribe(client, "device-a");
    }
    connections.broadcast("device-a", { type: "test" });
    expect(slow.socket.close).toHaveBeenCalledWith(1013, "backpressure");
    expect(fast.socket.send).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().transport.backpressureCloses).toBe(1);
    connections.broadcast("device-a", { text: "x".repeat(MAX_MESSAGE_BYTES) });
    expect(fast.socket.close).toHaveBeenCalledWith(1009, "payload-too-large");
    expect(fast.socket.send).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().transport.oversizedCloses).toBe(1);
  });
});
