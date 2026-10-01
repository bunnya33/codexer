import { testAccount, testAgent, testPassword } from "./account-helpers.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRelay } from "../apps/relay/src/server.js";
import { RelayStore } from "../apps/relay/src/store.js";
import { record } from "../packages/codex-adapter/src/normalize.js";
import type { DeviceCatalog, DeviceSnapshot } from "../packages/protocol/src/index.js";
import { command, event, snapshot, waitFor, WsPeer } from "./helpers.js";
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";

it("allows browser REST preflight only for configured origins and still requires a token", async () => {
  const store = await RelayStore.open();
  const account = await testAccount(store, "admin", "admin");
  const token = account.session;
  const relay = await createRelay({ store, allowedOrigins: ["http://127.0.0.1:5173"] });
  try {
    const headers = { origin: "http://127.0.0.1:5173" };
    const allowed = await relay.inject({ method: "OPTIONS", url: "/v1/me", headers: { ...headers, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(headers.origin);
    expect((await relay.inject({ url: "/v1/me", headers })).statusCode).toBe(401);
    expect((await relay.inject({ url: "/v1/me", headers: { ...headers, authorization: `Bearer ${token}` } })).json()).toMatchObject({ role: "admin" });
    const denied = await relay.inject({ method: "OPTIONS", url: "/v1/me", headers: { origin: "http://unknown.example" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect((await relay.inject({ method: "POST", url: "/v1/auth/login", headers: { host: "relay.example:8787", origin: "http://relay.example:8787" }, payload: { username: "admin", password: testPassword } })).statusCode).toBe(200);
    expect((await relay.inject({ method: "POST", url: "/v1/auth/login", headers: { host: "relay.example:8787", origin: "http://unknown.example" }, payload: { username: "admin", password: testPassword } })).statusCode).toBe(403);
  } finally { await relay.close(); }
});

it("serves rebuilt web assets without shadowing API routes", async () => {
  const webRoot = await mkdtemp(join(tmpdir(), "codex-remote-web-"));
  const adminRoot = await mkdtemp(join(tmpdir(), "codex-remote-admin-"));
  await writeFile(join(webRoot, "index.html"), "<title>Web test</title>");
  await writeFile(join(adminRoot, "index.html"), "<title>Admin test</title>");
  await writeFile(join(adminRoot, "admin.js"), "const admin = true;");
  const relay = await createRelay({ store: await RelayStore.open(), webRoot, adminRoot });
  try {
    expect((await relay.inject({ url: "/" })).body).toContain("Web test");
    expect((await relay.inject({ url: "/admin" })).headers.location).toBe("/admin/");
    expect((await relay.inject({ url: "/admin/" })).body).toContain("Admin test");
    expect((await relay.inject({ url: "/admin/admin.js" })).body).toContain("admin = true");
    expect((await relay.inject({ url: "/admin.js" })).statusCode).toBe(404);
    expect((await relay.inject({ url: "/admin/missing.js" })).statusCode).toBe(404);
    expect((await relay.inject({ url: "/v1/users" })).statusCode).toBe(401);
    await writeFile(join(webRoot, "new-build.js"), "export const version = 2;");
    expect((await relay.inject({ url: "/new-build.js" })).body).toContain("version = 2");
    expect((await relay.inject({ url: "/health" })).json()).toMatchObject({ ok: true, protocolVersion: 1 });
  } finally {
    await relay.close();
    await rm(webRoot, { recursive: true, force: true });
    await rm(adminRoot, { recursive: true, force: true });
  }
});

describe("authenticated relay transport", () => {
  const headers = { authorization: "" };
  let store: RelayStore, userId: string;
  let app: Awaited<ReturnType<typeof createRelay>>, base: string, ws: string, deviceId: string, token: string;
  const peers: WsPeer[] = [];
  beforeAll(async () => {
    store = await RelayStore.open();
    const account = await testAccount(store); userId = account.id; headers.authorization = account.headers.authorization;
    app = await createRelay({ store });
    base = await app.listen({ host: "127.0.0.1", port: 0 }); ws = base.replace("http:", "ws:");
  });
  beforeEach(async () => {
    const registered = await testAgent(store, userId); token = registered.token; deviceId = registered.id;
  });
  afterAll(async () => { for (const peer of peers) peer.socket.terminate(); await app.close(); });
  async function agent(): Promise<WsPeer> {
    const peer = await WsPeer.open(`${ws}/v1/ws/device`, { authorization: `Bearer ${token}`, "x-device-id": deviceId }); peers.push(peer);
    await peer.wait(value => value.type === "device.welcome"); return peer;
  }
  async function client(): Promise<WsPeer> {
    const response = await app.inject({ method: "POST", url: "/v1/ws/tickets", headers });
    const peer = await WsPeer.open(`${ws}/v1/ws/client`); peers.push(peer);
    peer.send({ type: "client.authenticate", ticket: response.json().ticket });
    await peer.wait(value => value.type === "client.authenticated"); return peer;
  }
  async function publish(peer: WsPeer, state: DeviceSnapshot): Promise<void> {
    peer.send({ type: "device.snapshot", snapshot: state });
    const subscriber = await client();
    subscriber.send({ type: "client.subscribe", deviceId });
    await subscriber.wait(value => value.type === "sync.ready");
    await subscriber.close();
  }
  it("rejects missing admin credentials and bad device credentials", async () => {
    expect((await app.inject({ url: "/v1/devices" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/ws/tickets" })).statusCode).toBe(401);
    await expect(WsPeer.open(`${ws}/v1/ws/device`, { authorization: "Bearer bad", "x-device-id": deviceId })).rejects.toThrow("401");
  });
  it("authenticates image uploads and downloads and enforces thread and device scope", async () => {
    const peer = await agent(); await publish(peer, snapshot(deviceId));
    const catalog = { protocolVersion: 1, deviceId, generatedAt: 1, projects: [], threads: ["thread-test", "other-thread"].map(id => ({ id, title: "Test", cwd: null, projectId: null, updatedAt: 1, archived: false })) };
    peer.send({ type: "device.catalog", catalog });
    await waitFor(async () => (await app.inject({ url: `/v1/devices/${deviceId}/catalog`, headers })).statusCode === 200);
    const path = `/v1/devices/${deviceId}/threads/thread-test/images`;
    const image = { name: "one.png", mimeType: "image/png", base64: pngBase64 };
    expect((await app.inject({ method: "POST", url: path, payload: image })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: path, headers, payload: { ...image, mimeType: "image/jpeg" } })).statusCode).toBe(400);
    const upload = await app.inject({ method: "POST", url: path, headers, payload: image });
    expect(upload.statusCode).toBe(200);
    const id = upload.json().id;
    expect((await app.inject({ url: `${path}/${id}` })).statusCode).toBe(401);
    const download = await app.inject({ url: `${path}/${id}`, headers });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("image/png");
    expect(download.headers["cache-control"]).toBe("no-store");
    expect(download.rawPayload.toString("base64")).toBe(pngBase64);
    const agentPath = `/v1/agent/${deviceId}/threads/thread-test/images/${id}`;
    expect((await app.inject({ url: agentPath, headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ url: agentPath, headers: { authorization: `Bearer ${token}` } })).json()).toMatchObject(image);
    expect((await app.inject({ url: agentPath.replace("thread-test", "other-thread"), headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(404);
    const bad = command({ type: "turn.start", threadId: "other-thread", text: "", images: [id] }, snapshot(deviceId));
    expect((await app.inject({ method: "POST", url: `/v1/devices/${deviceId}/commands`, headers, payload: bad })).statusCode).toBe(400);
  });
  it("fetches official images by opaque ID and ignores mismatched image responses", async () => {
    const peer = await agent(); await publish(peer, snapshot(deviceId));
    peer.send({ type: "device.catalog", catalog: { protocolVersion: 1, deviceId, generatedAt: 1, projects: [], threads: [{ id: "thread-test", title: "Test", cwd: null, projectId: null, updatedAt: 1, archived: false }] } });
    await waitFor(async () => (await app.inject({ url: `/v1/devices/${deviceId}/catalog`, headers })).statusCode === 200);
    const imageId = "b".repeat(64);
    const response = app.inject({ url: `/v1/devices/${deviceId}/threads/thread-test/images/${imageId}`, headers });
    const request = await peer.wait(value => value.type === "image.request");
    const image = { name: "result.png", mimeType: "image/png", base64: pngBase64 };
    peer.send({ type: "device.image", requestId: request.requestId, threadId: "other-thread", imageId, image });
    peer.send({ type: "device.image", requestId: request.requestId, threadId: "thread-test", imageId, image });
    expect((await response).rawPayload.toString("base64")).toBe(pngBase64);
    expect((await app.inject({ url: `/v1/devices/${deviceId}/threads/thread-test/images/${imageId}`, headers })).statusCode).toBe(200);
  });
  it("rejects reused tickets and unlisted browser origins", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/ws/tickets", headers });
    const first = await WsPeer.open(`${ws}/v1/ws/client`); peers.push(first);
    first.send({ type: "client.authenticate", ticket: response.json().ticket });
    await first.wait(value => value.type === "client.authenticated");
    const second = await WsPeer.open(`${ws}/v1/ws/client`); peers.push(second);
    second.send({ type: "client.authenticate", ticket: response.json().ticket });
    expect(await second.closed).toBe(1008);
    const denied = await WsPeer.open(`${ws}/v1/ws/client`, { origin: "https://unlisted.example.test" }); peers.push(denied);
    expect(await denied.closed).toBe(1008);
  });
  it("replays an ordered range and switches to a snapshot on an epoch mismatch", async () => {
    const peer = await agent(), state = snapshot(deviceId);
    await publish(peer, state);
    const subscriber = await client();
    subscriber.send({ type: "client.subscribe", deviceId }); await subscriber.wait(value => value.type === "sync.ready");
    const first = event(state); peer.send({ type: "device.event", event: first });
    await subscriber.wait(value => value.type === "device.event" && record(value.event).seq === 1);
    await subscriber.close();
    const replay = await client(); replay.send({ type: "client.subscribe", deviceId, epoch: state.epoch, lastSeq: 0 });
    expect((await replay.wait(value => value.type === "sync.begin")).mode).toBe("replay");
    expect(record((await replay.wait(value => value.type === "device.event")).event).seq).toBe(1);
    await replay.wait(value => value.type === "sync.ready");
    const reset = await client(); reset.send({ type: "client.subscribe", deviceId, epoch: "previous-epoch", lastSeq: 1 });
    expect((await reset.wait(value => value.type === "sync.begin")).mode).toBe("snapshot");
    expect(record((await reset.wait(value => value.type === "device.snapshot")).snapshot).lastSeq).toBe(1);
  });
  it("requests snapshot reconciliation after an event gap", async () => {
    const peer = await agent(), state = snapshot(deviceId);
    await publish(peer, state);
    peer.send({ type: "device.event", event: { ...event(state), seq: 2 } });
    expect((await peer.wait(value => value.type === "device.resync")).reason).toBe("sequence-gap");
    expect((await app.inject({ url: `/v1/devices/${deviceId}/snapshot`, headers })).json().snapshot.lastSeq).toBe(0);
  });
  it("fences an older agent connection and accepts the new epoch", async () => {
    const previous = await agent(); await publish(previous, snapshot(deviceId, "old-epoch"));
    const replacement = await agent(); expect(await previous.closed).toBe(4001);
    await publish(replacement, snapshot(deviceId, "new-epoch"));
    expect((await app.inject({ url: `/v1/devices/${deviceId}/snapshot`, headers })).json()).toMatchObject({ online: true, snapshot: { epoch: "new-epoch" } });
  });
  it("routes commands once, saves results and rejects changed payloads under the same ID", async () => {
    const peer = await agent(), state = snapshot(deviceId); await publish(peer, state);
    const input = command({ type: "turn.start", threadId: "thread-test", text: "Test" }, state);
    const submit = () => app.inject({ method: "POST", url: `/v1/devices/${deviceId}/commands`, headers, payload: input });
    expect((await submit()).json().type).toBe("command.accepted");
    await peer.wait(value => value.type === "command");
    expect((await submit()).json().type).toBe("command.accepted");
    expect(peer.messages.filter(value => value.type === "command")).toHaveLength(1);
    peer.send({ type: "command.result", result: { commandId: input.commandId, deviceId, status: "succeeded", code: "test-acknowledged" } });
    const subscriber = await client(); subscriber.send({ type: "client.subscribe", deviceId }); await subscriber.wait(value => value.type === "sync.ready");
    expect((await submit()).json()).toMatchObject({ type: "command.result", result: { status: "succeeded" } });
    expect((await app.inject({ method: "POST", url: `/v1/devices/${deviceId}/commands`, headers, payload: { ...input, payload: { ...input.payload, text: "changed" } } })).statusCode).toBe(409);
  });
  it("rejects stale epochs and blocks revoked devices immediately", async () => {
    const peer = await agent(), state = snapshot(deviceId); await publish(peer, state);
    const input = { ...command({ type: "turn.start", threadId: "thread-test", text: "Test" }, state), expectedEpoch: "old-epoch" };
    expect((await app.inject({ method: "POST", url: `/v1/devices/${deviceId}/commands`, headers, payload: input })).json().error).toBe("stale-device-epoch");
    expect((await app.inject({ method: "DELETE", url: `/v1/devices/${deviceId}`, headers })).statusCode).toBe(200);
    expect(await peer.closed).toBe(4003);
    expect((await app.inject({ url: `/v1/devices/${deviceId}/snapshot`, headers })).statusCode).toBe(404);
    await expect(WsPeer.open(`${ws}/v1/ws/device`, { authorization: `Bearer ${token}`, "x-device-id": deviceId })).rejects.toThrow("401");
  });
  it("stores the complete catalog and routes paginated history only for listed threads", async () => {
    const peer = await agent();
    const catalog: DeviceCatalog = { protocolVersion: 1, deviceId, generatedAt: Date.now(), projects: [{ id: "project", name: "Saved project", roots: ["/workspace"], position: 0, updatedAt: 1 }], threads: Array.from({ length: 30 }, (_, index) => ({ id: `old-${index}`, title: `Old ${index}`, cwd: "/workspace", projectId: "project", updatedAt: index, archived: false })) };
    peer.send({ type: "device.catalog", catalog });
    await waitFor(async () => (await app.inject({ url: `/v1/devices/${deviceId}/catalog`, headers })).statusCode === 200);
    expect((await app.inject({ url: `/v1/devices/${deviceId}/catalog`, headers })).json().catalog.threads).toHaveLength(30);
    expect((await app.inject({ url: `/v1/devices/${deviceId}/catalog` })).statusCode).toBe(401);
    expect((await app.inject({ url: `/v1/devices/${deviceId}/threads/missing/turns`, headers })).statusCode).toBe(404);
    const response = app.inject({ url: `/v1/devices/${deviceId}/threads/old-29/turns?cursor=next-page`, headers });
    const request = await peer.wait(value => value.type === "history.request");
    expect(request).toMatchObject({ threadId: "old-29", cursor: "next-page" });
    peer.send({ type: "device.history", requestId: request.requestId, threadId: "old-29", page: { threadId: "old-29", turns: [], nextCursor: null, generatedAt: Date.now() }, code: null });
    expect((await response).json()).toMatchObject({ threadId: "old-29", nextCursor: null });
    const pending = app.inject({ url: `/v1/devices/${deviceId}/threads/old-29/turns`, headers });
    await peer.wait(value => value.type === "history.request" && value.requestId !== request.requestId);
    await app.inject({ method: "DELETE", url: `/v1/devices/${deviceId}`, headers });
    expect((await pending).statusCode).toBe(404);
    expect((await app.inject({ url: `/v1/devices/${deviceId}/catalog`, headers })).statusCode).toBe(404);
  });
});
