import { testAccount, testPassword } from "./account-helpers.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PcAgent } from "../apps/pc-agent/src/agent.js";
import { loginAgent } from "../apps/pc-agent/src/auth.js";
import { createRelay } from "./go-relay.js";
import { RelayStore } from "./go-relay.js";
import { AdapterError } from "../packages/codex-adapter/src/desktop.js";
import { HeadlessAdapter } from "../packages/codex-adapter/src/headless.js";
import { record } from "../packages/codex-adapter/src/normalize.js";
import type { DeviceCatalog } from "../packages/protocol/src/index.js";
import { command, waitFor, WsPeer } from "./helpers.js";

function newThreadRpc(cwd: string) {
  const thread = { id: "new-thread", cwd, name: null as string | null, preview: "", model: "test-model", modelProvider: "test-provider", reasoningEffort: "high", updatedAt: 1, status: { type: "idle" } };
  let materialized = false;
  let failure: AdapterError | undefined;
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "thread/start") return { thread, model: thread.model, reasoningEffort: thread.reasoningEffort, approvalPolicy: "on-request", sandbox: { type: "readOnly" } };
    if (method === "thread/read") return { thread };
    if (method === "thread/turns/list") {
      if (failure) throw failure;
      if (!materialized) throw new AdapterError(`thread/turns/list-rejected:thread ${thread.id} is not materialized yet; thread/turns/list is unavailable before first user message`);
      return { data: [{ id: "first-turn", status: "completed", items: [] }], nextCursor: null };
    }
    if (method === "turn/start") { materialized = true; return { turn: { id: "first-turn" } }; }
    if (method === "thread/name/set") { thread.name = String(params.name); return {}; }
    if (method === "thread/settings/update") return {};
    if (method === "thread/delete") return {};
    throw new Error(`Unexpected app-server request: ${method}`);
  });
  return { rpc: { request, stop: async () => {} }, thread, fail: (error?: AdapterError) => { failure = error; } };
}

it("reads empty history and sends the first turn through the app-server that created the thread", async () => {
  const adapter = new HeadlessAdapter();
  const fake = newThreadRpc(process.cwd());
  Object.assign(adapter, { connected: true, rpc: fake.rpc });
  try {
    await adapter.manage({ type: "thread.create", projectId: "project-test" }, [process.cwd()]);
    expect(await adapter.follow("new-thread")).toBe(true);
    expect(adapter.getThread("new-thread")).toMatchObject({ status: "idle", ownerAvailable: true, settings: { model: "test-model", reasoningEffort: "high" } });
    expect(await adapter.history("new-thread", null)).toMatchObject({ turns: [], nextCursor: null });
    fake.fail(new AdapterError("thread/turns/list-timeout", true));
    await expect(adapter.history("new-thread", null)).rejects.toMatchObject({ code: "thread/turns/list-timeout" });
    fake.fail();
    await expect(adapter.execute(command({ type: "turn.start", threadId: "new-thread", text: "Hello" }))).resolves.toMatchObject({ turnId: "first-turn" });
    expect(fake.rpc.request.mock.calls.find(([method]) => method === "turn/start")?.[1]).toEqual({ threadId: "new-thread", input: [{ type: "text", text: "Hello", text_elements: [] }], clientUserMessageId: expect.any(String), effort: "high" });
    expect(fake.rpc.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
    expect(await adapter.history("new-thread", null)).toMatchObject({ turns: [{ id: "first-turn" }] });
  } finally { await adapter.stop(); }
});

it("selects Plan Mode before the first message, keeps it for the turn, and returns to default mode", async () => {
  const adapter = new HeadlessAdapter();
  const fake = newThreadRpc(process.cwd());
  Object.assign(adapter, {connected: true, rpc: fake.rpc});
  try {
    await adapter.manage({type: "thread.create", projectId: "project-test"}, [process.cwd()]);
    const payload = {type: "thread.mode.update" as const, threadId: "new-thread", mode: "plan" as const, expectedMode: null, expectedModel: "test-model", expectedEffort: "high"};
    await expect(adapter.execute(command(payload))).resolves.toMatchObject({mode: "plan", acknowledgedByAppServer: true});
    expect(adapter.getThread("new-thread")?.settings?.collaborationMode).toBe("plan");
    const mode = {mode: "plan", settings: {model: "test-model", reasoning_effort: "high", developer_instructions: null}};
    expect(fake.rpc.request.mock.calls.find(([method]) => method === "thread/settings/update")?.[1]).toEqual({threadId: "new-thread", collaborationMode: mode});
    await expect(adapter.execute(command({...payload, expectedMode: "default"}))).rejects.toMatchObject({code: "stale-settings"});
    await adapter.execute(command({...payload, mode: "default", expectedMode: "plan"}));
    expect(adapter.getThread("new-thread")?.settings?.collaborationMode).toBe("default");
    await adapter.execute(command({...payload, expectedMode: "default"}));
    await adapter.execute(command({type: "turn.start", threadId: "new-thread", text: "Discuss the plan"}));
    expect(fake.rpc.request.mock.calls.find(([method]) => method === "turn/start")?.[1]).toMatchObject({collaborationMode: mode, effort: "high"});
    expect(fake.rpc.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
  } finally { await adapter.stop(); }
});

it("publishes new threads before acknowledging creation and retains them during an older catalog refresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codexer-new-thread-"));
  const headers = { authorization: "" };
  const store = await RelayStore.open();
  const account = await testAccount(store); headers.authorization = account.headers.authorization;
  const app = await createRelay({ store });
  let agent: PcAgent | undefined, peer: WsPeer | undefined, releaseRefresh: (() => void) | undefined;
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const credentials = await loginAgent(base, join(directory, "credentials.secret"), account.name, testPassword);
    let catalog: DeviceCatalog = { protocolVersion: 1, deviceId: credentials.deviceId, generatedAt: 1, projects: [{ id: "project-test", name: "Project", roots: [directory], position: 0, updatedAt: 1 }], threads: [] };
    let holdRefresh = false;
    const catalogReader = { list: async () => {
      const previous = catalog;
      if (holdRefresh) await new Promise<void>(resolve => { releaseRefresh = resolve; });
      return previous;
    }, history: vi.fn(async () => { throw new Error("An empty thread is invisible to a separate app-server"); }) };
    agent = new PcAgent(credentials, join(directory, "agent"), [], undefined, join(directory, "codex-home"), "headless", catalogReader);
    const headless = (agent as unknown as { headless: HeadlessAdapter }).headless;
    const fake = newThreadRpc(directory);
    Object.assign(headless, { connected: true, rpc: fake.rpc });
    await agent.start();
    await waitFor(async () => (await app.inject({ url: `/v1/devices/${credentials.deviceId}/catalog`, headers })).statusCode === 200);
    const ticket = (await app.inject({ method: "POST", url: "/v1/ws/tickets", headers })).json().ticket;
    peer = await WsPeer.open(`${base.replace("http:", "ws:")}/v1/ws/client`);
    peer.send({ type: "client.authenticate", ticket }); await peer.wait(message => message.type === "client.authenticated");
    peer.send({ type: "client.subscribe", deviceId: credentials.deviceId }); await peer.wait(message => message.type === "sync.ready");

    holdRefresh = true;
    const refreshing = (agent as unknown as { refreshCatalog(): Promise<void> }).refreshCatalog();
    await waitFor(() => !!releaseRefresh);
    const create = command({ type: "thread.create", projectId: "project-test" }, agent.snapshot());
    peer.send({ type: "client.command", command: create });
    expect(record((await peer.wait(message => message.type === "command.result" && record(message.result).commandId === create.commandId)).result)).toMatchObject({ status: "succeeded", result: { threadId: "new-thread" } });
    const catalogUrl = `/v1/devices/${credentials.deviceId}/catalog`;
    expect((await app.inject({ url: catalogUrl, headers })).json().catalog.threads).toMatchObject([{ id: "new-thread", projectId: "project-test", archived: false }]);
    holdRefresh = false; releaseRefresh!(); await refreshing;
    expect((await app.inject({ url: catalogUrl, headers })).json().catalog.threads).toHaveLength(1);
    const historyUrl = `/v1/devices/${credentials.deviceId}/threads/new-thread/turns`;
    const history = await app.inject({ url: historyUrl, headers });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ threadId: "new-thread", turns: [], nextCursor: null });
    expect(catalogReader.history).not.toHaveBeenCalled();

    const rename = command({ type: "thread.rename", threadId: "new-thread", name: "Empty conversation" }, agent.snapshot());
    peer.send({ type: "client.command", command: rename });
    expect(record((await peer.wait(message => message.type === "command.result" && record(message.result).commandId === rename.commandId)).result).status).toBe("succeeded");
    expect((await app.inject({ url: catalogUrl, headers })).json().catalog.threads[0]?.title).toBe("Empty conversation");

    const watch = command({ type: "thread.watch", threadId: "new-thread" }, agent.snapshot());
    peer.send({ type: "client.command", command: watch });
    expect(record((await peer.wait(message => message.type === "command.result" && record(message.result).commandId === watch.commandId)).result).status).toBe("succeeded");
    const firstTurn = command({ type: "turn.start", threadId: "new-thread", text: "Hello" }, agent.snapshot());
    peer.send({ type: "client.command", command: firstTurn });
    expect(record((await peer.wait(message => message.type === "command.result" && record(message.result).commandId === firstTurn.commandId)).result).status).toBe("succeeded");

    catalog = { ...catalog, generatedAt: 2, threads: [{ id: "new-thread", title: "Saved title", cwd: directory, projectId: "project-test", updatedAt: 2, archived: false }] };
    await (agent as unknown as { refreshCatalog(): Promise<void> }).refreshCatalog();
    await waitFor(async () => (await app.inject({ url: catalogUrl, headers })).json().catalog.threads[0]?.title === "Saved title");
    expect((await app.inject({ url: catalogUrl, headers })).json().catalog.threads).toHaveLength(1);
  } finally {
    releaseRefresh?.(); await peer?.close(); await agent?.stop(); await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
