import { expect, it, vi } from "vitest";
import { createRelay } from "../apps/relay/src/server.js";
import { RelayStore } from "../apps/relay/src/storage/store.js";
import { testAccount, testAgent } from "./account-helpers.js";
import { command, event, snapshot, waitFor, WsPeer } from "./helpers.js";
import type { CommandResult } from "../packages/protocol/src/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(options: { heartbeatMs?: number } = {}) {
  const store = await RelayStore.open();
  const admin = await testAccount(store, "Admin", "admin");
  const user = await testAccount(store, "User");
  const app = await createRelay({ store, ...options });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const peers: WsPeer[] = [];
  const devices = [];
  for (let index = 0; index < 2; index++) {
    const registered = await testAgent(store, user.id);
    const peer = await WsPeer.open(base.replace("http:", "ws:") + "/v1/ws/device", {
      authorization: `Bearer ${registered.token}`,
      "x-device-id": registered.id,
    });
    peers.push(peer);
    await peer.wait((message) => message.type === "device.welcome");
    const state = snapshot(registered.id);
    peer.send({ type: "device.snapshot", snapshot: state });
    await waitFor(async () => !!(await store.snapshot(registered.id)));
    devices.push({ id: registered.id, peer, state });
  }
  return {
    store,
    app,
    admin,
    user,
    devices,
    async client() {
      const response = await app.inject({
        method: "POST",
        url: "/v1/ws/tickets",
        headers: user.headers,
      });
      const peer = await WsPeer.open(base.replace("http:", "ws:") + "/v1/ws/client");
      peers.push(peer);
      peer.send({ type: "client.authenticate", ticket: response.json().ticket });
      await peer.wait((message) => message.type === "client.authenticated");
      return peer;
    },
    async metrics() {
      return (await app.inject({ url: "/v1/admin/metrics", headers: admin.headers })).json();
    },
    async close() {
      for (const peer of peers) peer.socket.terminate();
      await app.close();
    },
  };
}

it("lets another device advance while one device is slow, preserving the slow device's event order", async () => {
  const f = await fixture();
  const gate = deferred(),
    entered = deferred();
  const [a, b] = f.devices;
  const save = f.store.saveEvent.bind(f.store);
  const spy = vi.spyOn(f.store, "saveEvent").mockImplementation(async (input) => {
    if (input.deviceId === a!.id && input.seq === 1) {
      entered.resolve();
      await gate.promise;
    }
    return save(input);
  });
  try {
    a!.peer.send({ type: "device.event", event: event(a!.state, false) });
    await entered.promise;
    a!.peer.send({ type: "device.event", event: event({ ...a!.state, lastSeq: 1 }, true) });
    b!.peer.send({ type: "device.event", event: event(b!.state, false) });
    await waitFor(async () => (await f.store.snapshot(b!.id))?.lastSeq === 1);
    expect((await f.store.snapshot(a!.id))!.lastSeq).toBe(0);
    gate.resolve();
    await waitFor(async () => (await f.store.snapshot(a!.id))?.lastSeq === 2);
    expect((await f.store.snapshot(a!.id))!.runtime.connected).toBe(true);
    expect((await f.metrics()).scheduler.lanes.device.completed).toBeGreaterThan(0);
  } finally {
    gate.resolve();
    spy.mockRestore();
    await f.close();
  }
});

it("waits for prior device work before revocation and rejects a command queued behind the revocation barrier", async () => {
  const f = await fixture();
  const a = f.devices[0]!;
  const gate = deferred(),
    entered = deferred();
  const save = f.store.saveEvent.bind(f.store);
  const spy = vi.spyOn(f.store, "saveEvent").mockImplementation(async (input) => {
    entered.resolve();
    await gate.promise;
    return save(input);
  });
  try {
    a.peer.send({ type: "device.event", event: event(a.state) });
    await entered.promise;
    const revoke = f.app
      .inject({ method: "DELETE", url: `/v1/users/${f.user.id}`, headers: f.admin.headers })
      .then((response) => response);
    await waitFor(async () => (await f.metrics()).scheduler.lanes.exclusive.waiting > 0);
    const input = command({ type: "turn.start", threadId: "thread-test", text: "test" }, a.state);
    const dispatch = f.app
      .inject({
        method: "POST",
        url: `/v1/devices/${a.id}/commands`,
        headers: f.user.headers,
        payload: input,
      })
      .then((response) => response);
    await waitFor(async () => (await f.metrics()).scheduler.lanes.device.waiting > 0);
    gate.resolve();
    expect((await revoke).statusCode).toBe(200);
    expect((await dispatch).statusCode).toBe(404);
    expect(a.peer.messages.some((message) => message.type === "command")).toBe(false);
    expect(await a.peer.closed).toBe(4003);
  } finally {
    gate.resolve();
    spy.mockRestore();
    await f.close();
  }
});

it("finishes snapshot synchronization before delivering a later live event", async () => {
  const f = await fixture();
  const a = f.devices[0]!;
  const client = await f.client();
  const gate = deferred(),
    entered = deferred();
  const read = f.store.snapshot.bind(f.store);
  const spy = vi.spyOn(f.store, "snapshot").mockImplementation(async (id) => {
    const state = await read(id);
    if (id === a.id) {
      entered.resolve();
      await gate.promise;
    }
    return state;
  });
  try {
    client.send({ type: "client.subscribe", deviceId: a.id });
    await entered.promise;
    a.peer.send({ type: "device.event", event: event(a.state) });
    gate.resolve();
    await client.wait((message) => message.type === "device.event");
    const types = client.messages.map((message) => message.type);
    expect(types.indexOf("sync.begin")).toBeLessThan(types.indexOf("sync.ready"));
    expect(types.indexOf("sync.ready")).toBeLessThan(types.indexOf("device.event"));
  } finally {
    gate.resolve();
    spy.mockRestore();
    await f.close();
  }
});

it("does not restore a subscription if a client disconnects while its snapshot is being read", async () => {
  const f = await fixture();
  const a = f.devices[0]!;
  const client = await f.client();
  const gate = deferred(),
    entered = deferred();
  const read = f.store.snapshot.bind(f.store);
  const spy = vi.spyOn(f.store, "snapshot").mockImplementation(async (id) => {
    entered.resolve();
    await gate.promise;
    return read(id);
  });
  try {
    client.send({ type: "client.subscribe", deviceId: a.id });
    await entered.promise;
    await client.close();
    await waitFor(async () => (await f.metrics()).connections.onlineClients === 0);
    gate.resolve();
    await waitFor(async () => (await f.metrics()).scheduler.lanes.device.running === 0);
    expect((await f.metrics()).connections.subscriptions).toBe(0);
  } finally {
    gate.resolve();
    spy.mockRestore();
    await f.close();
  }
});

it("processes a queued Agent result before maintenance marks its command as unknown", async () => {
  const f = await fixture({ heartbeatMs: 50 });
  const a = f.devices[0]!;
  const scanGate = deferred(),
    scanEntered = deferred();
  const eventGate = deferred(),
    eventEntered = deferred();
  const discover = f.store.expiredCommandDevices.bind(f.store);
  const scanSpy = vi.spyOn(f.store, "expiredCommandDevices").mockImplementation(async () => {
    scanEntered.resolve();
    await scanGate.promise;
    return discover();
  });
  const save = f.store.saveEvent.bind(f.store);
  const eventSpy = vi.spyOn(f.store, "saveEvent").mockImplementation(async (input) => {
    eventEntered.resolve();
    await eventGate.promise;
    return save(input);
  });
  const expireSpy = vi.spyOn(f.store, "expireCommands");
  try {
    // Hold discovery so the heartbeat cannot enqueue expiry before the Agent reply arrives.
    await scanEntered.promise;
    const input = command({ type: "turn.start", threadId: "thread-test", text: "test" }, a.state);
    await f.store.addCommand({ ...input, expiresAt: Date.now() - 10000 });
    a.peer.send({ type: "device.event", event: event(a.state) });
    await eventEntered.promise;
    const result: CommandResult = {
      deviceId: a.id,
      commandId: input.commandId,
      status: "succeeded",
      code: "ok",
    };
    a.peer.send({ type: "command.result", result });
    await waitFor(async () => (await f.metrics()).scheduler.lanes.device.waiting >= 1);
    scanGate.resolve();
    await waitFor(async () => (await f.metrics()).scheduler.lanes.device.waiting >= 2);
    expect((await f.store.command(a.id, input.commandId))!.status).toBe("pending");
    eventGate.resolve();
    await waitFor(
      async () => (await f.store.command(a.id, input.commandId))?.status === "succeeded",
    );
    await waitFor(() => expireSpy.mock.calls.some(([id]) => id === a.id));
    expect((await f.store.command(a.id, input.commandId))!.result).toMatchObject({
      status: "succeeded",
    });
  } finally {
    scanGate.resolve();
    eventGate.resolve();
    scanSpy.mockRestore();
    eventSpy.mockRestore();
    expireSpy.mockRestore();
    await f.close();
  }
});
