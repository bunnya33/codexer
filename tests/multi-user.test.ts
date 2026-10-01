import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { createRelay } from "../apps/relay/src/server.js";
import { hash, RelayStore } from "../apps/relay/src/store.js";
import { testAccount, testPassword } from "./account-helpers.js";
import { command, snapshot, waitFor, WsPeer } from "./helpers.js";

const auth = (session: string) => ({ authorization: `Bearer ${session}` });
async function fixture() {
  const store = await RelayStore.open();
  const admin = await testAccount(store, "admin", "admin");
  const app = await createRelay({ store, heartbeatMs: 50 });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const peers: WsPeer[] = [];
  const user = async (username: string) => {
    const created = await app.inject({ method: "POST", url: "/v1/users", headers: admin.headers, payload: { username, password: testPassword } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).not.toHaveProperty("token");
    const logged = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { username, password: testPassword } });
    expect(logged.statusCode).toBe(200);
    return { id: created.json().id as string, session: logged.json().session as string, username };
  };
  const agent = async (username: string, installationId = randomUUID()) => {
    const result = await app.inject({ method: "POST", url: "/v1/agents/login", payload: { username, password: testPassword, installationId, name: "PC", platform: "win32" } });
    expect(result.statusCode).toBe(200);
    const { deviceId, session } = result.json() as { deviceId: string; session: string };
    const peer = await WsPeer.open(`${base.replace("http:", "ws:")}/v1/ws/device`, { ...auth(session), "x-device-id": deviceId }); peers.push(peer);
    await peer.wait(message => message.type === "device.welcome");
    peer.send({ type: "device.snapshot", snapshot: snapshot(deviceId) });
    peer.send({ type: "device.catalog", catalog: { protocolVersion: 1, deviceId, generatedAt: 1, projects: [], threads: [{ id: "thread-test", title: "Test", cwd: null, projectId: null, updatedAt: 1, archived: false }] } });
    await waitFor(async () => !!await store.catalog(deviceId));
    return { id: deviceId, session, peer };
  };
  const ticket = async (session: string) => (await app.inject({ method: "POST", url: "/v1/ws/tickets", headers: auth(session) })).json().ticket as string;
  const client = async (session: string) => {
    const peer = await WsPeer.open(`${base.replace("http:", "ws:")}/v1/ws/client`); peers.push(peer);
    peer.send({ type: "client.authenticate", ticket: await ticket(session) });
    await peer.wait(message => message.type === "client.authenticated");
    return peer;
  };
  return { store, admin, app, base, user, agent, ticket, client, peers, close: async () => { for (const peer of peers) peer.socket.terminate(); await app.close(); } };
}

it("shows only same-account PCs, blocks foreign data and commands, and gives admins no access to other accounts PCs", async () => {
  const f = await fixture();
  try {
    const alice = await f.user("Alice"), bob = await f.user("Bob");
    const a1 = await f.agent("Alice"), a2 = await f.agent("Alice"), b = await f.agent("Bob");
    const list = async (session: string) => (await f.app.inject({ url: "/v1/devices", headers: auth(session) })).json().devices;
    expect((await list(alice.session)).map((d: { id: string }) => d.id)).toEqual([a1.id, a2.id]);
    expect(await list(bob.session)).toMatchObject([{ id: b.id, online: true }]);
    expect((await f.app.inject({ url: "/v1/devices", headers: f.admin.headers })).json().devices).toEqual([]);
    expect((await f.app.inject({ method: "POST", url: "/v1/ws/tickets", headers: f.admin.headers })).statusCode).toBe(200);
    expect((await f.app.inject({ url: "/v1/users", headers: auth(alice.session) })).statusCode).toBe(403);
    const ownAdminPC = await f.agent("admin");
    expect(await list(f.admin.session)).toMatchObject([{ id: ownAdminPC.id }]);
    const adminClient = await f.client(f.admin.session);
    adminClient.send({ type: "client.subscribe", deviceId: ownAdminPC.id });
    await adminClient.wait(message => message.type === "sync.ready");
    const root = `/v1/devices/${b.id}`;
    for (const url of [`${root}/snapshot`, `${root}/catalog`, `${root}/threads/thread-test/turns`, `${root}/commands/${randomUUID()}`, `${root}/threads/thread-test/images/${"b".repeat(64)}`]) {
      expect((await f.app.inject({ url, headers: auth(alice.session) })).statusCode, url).toBe(404);
    }
    const input = command({ type: "turn.start", threadId: "thread-test", text: "secret" }, snapshot(b.id));
    expect((await f.app.inject({ method: "POST", url: `${root}/commands`, headers: auth(alice.session), payload: input })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "POST", url: `${root}/commands`, headers: f.admin.headers, payload: input })).statusCode).toBe(404);
    const peer = await f.client(alice.session);
    peer.send({ type: "client.subscribe", deviceId: b.id });
    expect((await peer.wait(message => message.type === "error")).code).toBe("device-not-found");
    peer.send({ type: "client.command", command: input });
    await waitFor(() => peer.messages.filter(message => message.type === "error").length === 2);
    expect(b.peer.messages.some(message => message.type === "command")).toBe(false);
    peer.send({ type: "client.subscribe", deviceId: a2.id });
    await peer.wait(message => message.type === "sync.ready");
    expect((await f.app.inject({ url: "/v1/me", headers: auth(a1.session) })).statusCode).toBe(401);
    await expect(WsPeer.open(`${f.base.replace("http:", "ws:")}/v1/ws/device`, { ...auth(a1.session), "x-device-id": a2.id })).rejects.toThrow("401");
    for (const url of ["/v1/pairing/start", `/v1/users/${alice.id}/token`, `${root}/owner`]) expect((await f.app.inject({ method: "POST", url, headers: f.admin.headers, payload: {} })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "PUT", url: `${root}/owner`, headers: f.admin.headers, payload: { userId: alice.id } })).statusCode).toBe(404);
  } finally { await f.close(); }
}, 15000);

it("revokes live clients, PC sessions and unused tickets on password reset or account disable", async () => {
  const f = await fixture();
  try {
    const user = await f.user("Reset"); const agent = await f.agent("Reset"), client = await f.client(user.session);
    const ticket = await f.ticket(user.session);
    const result = await f.app.inject({ method: "PUT", url: `/v1/users/${user.id}/password`, headers: f.admin.headers, payload: { password: "new-password-123456" } });
    expect(result.statusCode).toBe(200);
    expect(await client.closed).toBe(4003); expect(await agent.peer.closed).toBe(4003);
    expect((await f.app.inject({ url: "/v1/me", headers: auth(user.session) })).statusCode).toBe(401);
    expect(await f.store.authorizeDevice(agent.id, agent.session)).toBe(false);
    expect(await f.store.consumeTicket(ticket)).toBeNull();
    expect((await f.app.inject({ method: "POST", url: "/v1/auth/login", payload: { username: "Reset", password: testPassword } })).statusCode).toBe(401);
    const logged = (await f.app.inject({ method: "POST", url: "/v1/auth/login", payload: { username: "Reset", password: "new-password-123456" } })).json();
    const second = await f.client(logged.session);
    expect((await f.app.inject({ method: "DELETE", url: `/v1/users/${user.id}`, headers: f.admin.headers })).statusCode).toBe(200);
    expect(await second.closed).toBe(4003);
    expect((await f.app.inject({ method: "POST", url: "/v1/auth/login", payload: { username: "Reset", password: "new-password-123456" } })).statusCode).toBe(401);
  } finally { await f.close(); }
}, 15000);

it("expires sessions, consumes tickets once, and revokes the current login on logout", async () => {
  const f = await fixture();
  try {
    const user = await f.user("Logout"), peer = await f.client(user.session), ticket = await f.ticket(user.session);
    expect((await f.app.inject({ method: "POST", url: "/v1/auth/logout", headers: auth(user.session) })).statusCode).toBe(200);
    expect(await peer.closed).toBe(4003); expect(await f.store.consumeTicket(ticket)).toBeNull();
    expect((await f.app.inject({ url: "/v1/me", headers: auth(user.session) })).statusCode).toBe(401);
    const expired = await f.store.createSession(user.id); const principal = await f.store.sessionPrincipal(expired.session);
    expect(principal).not.toBeNull();
    // Time advances via the persisted expiry; an idle socket must also lose access.
    const oldNow = Date.now; Date.now = () => expired.expiresAt + 1;
    try { expect(await f.store.sessionPrincipal(expired.session)).toBeNull(); } finally { Date.now = oldNow; }
    const fresh = await f.store.createSession(user.id); const p = await f.store.sessionPrincipal(fresh.session);
    const once = await f.store.ticket(p!); expect(await f.store.consumeTicket(once.ticket)).toEqual(p); expect(await f.store.consumeTicket(once.ticket)).toBeNull();
  } finally { await f.close(); }
});

it("limits password guessing and rejects duplicate account names", async () => {
  const f = await fixture();
  try {
    await f.user("Unique");
    expect((await f.app.inject({ method: "POST", url: "/v1/users", headers: f.admin.headers, payload: { username: "unique", password: testPassword } })).statusCode).toBe(409);
    for (let i = 0; i < 10; i++) await f.app.inject({ remoteAddress: "127.0.0." + (i + 2), method: "POST", url: "/v1/auth/login", payload: { username: "unknown", password: "wrong" } });
    expect((await f.app.inject({ method: "POST", url: "/v1/auth/login", payload: { username: "unknown", password: "wrong" } })).statusCode).toBe(429);
    expect((await f.app.inject({ method: "POST", url: "/v1/agents/login", payload: { username: "unknown", password: "wrong", installationId: randomUUID(), name: "PC", platform: "win32" } })).statusCode).toBe(429);
  } finally { await f.close(); }
});

it("preserves legacy users and PC data while disabling old token authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-migration-")), directory = join(root, "relay"), userId = randomUUID();
  const db = new PGlite(directory); await db.waitReady;
  await db.query("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,created_at BIGINT NOT NULL,revoked_at BIGINT)");
  await db.query("INSERT INTO users VALUES($1,'Legacy',$2,1,NULL)", [userId, hash("old-token")]); await db.close();
  const store = await RelayStore.open(undefined, directory);
  try {
    expect(await store.sessionPrincipal("old-token")).toBeNull(); expect(await store.checkPassword("Legacy", "old-token")).toBeNull();
    expect(await store.listUsers()).toMatchObject([{ id: userId, login_enabled: false }]);
    expect(await store.resetPassword(userId, testPassword)).toBe(true); expect(await store.checkPassword("Legacy", testPassword)).toEqual({ id: userId, kind: "user" });
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
