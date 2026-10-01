import { testAccount, testPassword } from "./account-helpers.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PcAgent } from "../apps/pc-agent/src/agent.js";
import { loginAgent } from "../apps/pc-agent/src/auth.js";
import { createRelay } from "../apps/relay/src/server.js";
import { RelayStore } from "../apps/relay/src/store.js";
import { record } from "../packages/codex-adapter/src/normalize.js";
import { snapshotSchema } from "../packages/protocol/src/index.js";
import type { DeviceCatalog } from "../packages/protocol/src/index.js";
import { command, FakeDesktop, rawThread, waitFor, WsPeer } from "./helpers.js";

it("pairs the agent, streams desktop state, deduplicates controls, and recovers from desktop and relay restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-remote-integration-"));
  const desktop = new FakeDesktop(); desktop.state = rawThread("idle");
  const headers = { authorization: "" };
  const database = join(directory, "relay");
  const store = await RelayStore.open(undefined, database);
  const account = await testAccount(store); headers.authorization = account.headers.authorization;
  let app = await createRelay({ store });
  let agent: PcAgent | undefined, peer: WsPeer | undefined;
  try {
    await desktop.start();
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const credentials = await loginAgent(base, join(directory, "credentials.secret"), account.name, testPassword);
    const catalog: DeviceCatalog = { protocolVersion: 1, deviceId: credentials.deviceId, generatedAt: Date.now(), projects: [{ id: "project-test", name: "Project", roots: ["/workspace"], position: 0, updatedAt: 1 }], threads: Array.from({ length: 25 }, (_, index) => ({ id: index === 0 ? "thread-test" : `old-${index}`, title: `Thread ${index}`, cwd: "/workspace", projectId: "project-test", updatedAt: index, archived: false })) };
    const catalogReader = { list: async () => catalog, history: async (threadId: string, cursor: string | null) => ({ threadId, turns: [{ id: cursor ? "older-turn" : "old-turn", status: "completed", items: [], truncated: false }], nextCursor: cursor ? null : "older", generatedAt: Date.now() }) };
    const makeAgent = () => new PcAgent(credentials, join(directory, "agent"), ["thread-test"], desktop.endpoint, join(directory, "empty-codex-home"), "auto", catalogReader);
    agent = makeAgent(); await agent.start();
    await waitFor(() => agent!.snapshot().threads["thread-test"]?.status === "idle");
    const ticket = (await app.inject({ method: "POST", url: "/v1/ws/tickets", headers })).json().ticket;
    peer = await WsPeer.open(`${base.replace("http:", "ws:")}/v1/ws/client`);
    peer.send({ type: "client.authenticate", ticket }); await peer.wait(value => value.type === "client.authenticated");
    peer.send({ type: "client.subscribe", deviceId: credentials.deviceId });
    const first = snapshotSchema.parse((await peer.wait(value => value.type === "device.snapshot")).snapshot);
    await peer.wait(value => value.type === "sync.ready");
    expect(first.threads["thread-test"]?.ownerAvailable).toBe(true);
    await waitFor(async () => (await app.inject({ url: `/v1/devices/${credentials.deviceId}/catalog`, headers })).statusCode === 200);
    expect((await app.inject({ url: `/v1/devices/${credentials.deviceId}/catalog`, headers })).json().catalog.threads).toHaveLength(25);
    const historyUrl = `/v1/devices/${credentials.deviceId}/threads/old-24/turns`;
    expect((await app.inject({ url: historyUrl, headers })).json()).toMatchObject({ threadId: "old-24", nextCursor: "older" });
    expect((await app.inject({ url: `${historyUrl}?cursor=older`, headers })).json()).toMatchObject({ nextCursor: null, turns: [{ id: "older-turn" }] });
    desktop.state.title = "Changed"; desktop.publishSnapshot();
    await peer.wait(value => value.type === "device.event" && record(record(value.event).change).type === "thread.updated");
    const input = command({ type: "turn.start", threadId: "thread-test", text: "Test" }, first);
    peer.send({ type: "client.command", command: input });
    expect(record((await peer.wait(value => value.type === "command.result" && record(value.result).commandId === input.commandId)).result).status).toBe("succeeded");
    peer.send({ type: "client.command", command: input });
    await waitFor(() => peer!.messages.filter(value => value.type === "command.result" && record(value.result).commandId === input.commandId).length === 2);
    expect(desktop.received.filter(value => value.method === "thread-follower-start-turn")).toHaveLength(1);

    desktop.state = rawThread("active"); desktop.publishSnapshot();
    await waitFor(() => agent!.snapshot().threads["thread-test"]?.status === "active");
    const queued = command({ type: "turn.queue", threadId: "thread-test", text: "Change direction" }, first);
    peer.send({ type: "client.command", command: queued });
    expect(record((await peer.wait(value => value.type === "command.result" && record(value.result).commandId === queued.commandId)).result).status).toBe("succeeded");
    await waitFor(() => agent!.snapshot().threads["thread-test"]?.queuedMessages?.[0]?.text === "Change direction");
    const steer = command({ type: "turn.queue.steer", threadId: "thread-test", turnId: "turn-A", queueId: queued.commandId }, first);
    peer.send({ type: "client.command", command: steer });
    expect(record((await peer.wait(value => value.type === "command.result" && record(value.result).commandId === steer.commandId)).result).status).toBe("succeeded");
    expect(desktop.received.filter(value => value.method === "thread-follower-steer-turn")).toHaveLength(1);
    await waitFor(() => agent!.snapshot().threads["thread-test"]?.queuedMessages?.length === 0);
    const followUp = command({ type: "turn.queue", threadId: "thread-test", text: "Run later" }, first);
    peer.send({ type: "client.command", command: followUp });
    expect(record((await peer.wait(value => value.type === "command.result" && record(value.result).commandId === followUp.commandId)).result).status).toBe("succeeded");
    desktop.state = rawThread("idle"); desktop.publishSnapshot();
    await waitFor(() => desktop.received.filter(value => value.method === "thread-follower-start-turn").length === 2);
    await waitFor(() => agent!.snapshot().threads["thread-test"]?.queuedMessages?.length === 0);

    desktop.disconnectClients();
    await waitFor(() => agent!.snapshot().runtime.connected === false);
    await waitFor(() => agent!.snapshot().runtime.connected && agent!.snapshot().threads["thread-test"]?.status === "idle", 8000);
    await peer.close(); peer = undefined;
    await app.close();
    app = await createRelay({ store: await RelayStore.open(undefined, database) });
    expect((await app.inject({ url: `/v1/devices/${credentials.deviceId}/catalog`, headers })).json().catalog.threads).toHaveLength(25);
    await app.listen({ host: "127.0.0.1", port: Number(new URL(base).port) });
    await waitFor(async () => {
      const response = await app.inject({ url: "/v1/devices", headers });
      return response.json().devices.some((device: { id: string; online: boolean }) => device.id === credentials.deviceId && device.online);
    }, 8000);
    expect((await app.inject({ url: `/v1/devices/${credentials.deviceId}/snapshot`, headers })).json().snapshot.epoch).toBe(first.epoch);

    await agent.stop();
    agent = makeAgent(); await agent.start();
    await waitFor(() => agent!.snapshot().threads["thread-test"]?.status === "idle");
    expect(agent.snapshot().epoch).not.toBe(first.epoch);
    const oldResult = await app.inject({ method: "POST", url: `/v1/devices/${credentials.deviceId}/commands`, headers, payload: input });
    expect(oldResult.json()).toMatchObject({ type: "command.result", result: { status: "succeeded" } });
    expect(desktop.received.filter(value => value.method === "thread-follower-start-turn")).toHaveLength(2);

  } finally {
    peer?.socket.terminate(); await agent?.stop(); await app.close(); await desktop.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
