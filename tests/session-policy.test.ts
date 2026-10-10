import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRelay, RelayStore, hash } from "./go-relay.js";
import { testAccount } from "./account-helpers.js";
import { WsPeer } from "./helpers.js";

it("restricts idle policy to admins and renews only browser activity", async () => {
  const store = await RelayStore.open(),
    admin = await testAccount(store, "admin", "admin"),
    user = await testAccount(store);
  const device = await store.registerAgent(user.id, randomUUID(), "PC", "darwin"),
    agent = await store.createSession(user.id, device);
  const app = await createRelay({ store });
  try {
    const path = "/v1/admin/auth-settings";
    expect((await app.inject({ url: path })).statusCode).toBe(401);
    expect((await app.inject({ url: path, headers: user.headers })).statusCode).toBe(403);
    for (const idleTimeoutMinutes of [0, -1, 1.5, 43201, "60"])
      expect(
        (
          await app.inject({
            method: "PUT",
            url: path,
            headers: admin.headers,
            payload: { idleTimeoutMinutes },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: path,
          headers: admin.headers,
          payload: { idleTimeoutMinutes: 2 },
        })
      ).json(),
    ).toEqual({ idleTimeoutMinutes: 2 });
    const fresh = await store.createSession(user.id);
    await store.query("UPDATE sessions SET last_active_at=$2,expires_at=$3 WHERE hash=$1", [
      hash(fresh.session),
      Date.now() - 90000,
      Date.now() + 30000,
    ]);
    const before = Date.now();
    const renewed = await app.inject({
      method: "POST",
      url: "/v1/auth/active",
      headers: { authorization: `Bearer ${fresh.session}` },
    });
    expect(renewed.json().idleTimeoutMinutes).toBe(2);
    expect(renewed.json().expiresAt).toBeGreaterThanOrEqual(before + 120000);
    await store.query("UPDATE sessions SET expires_at=$2 WHERE hash=$1", [
      hash(user.session),
      Date.now() - 1,
    ]);
    expect((await app.inject({ url: "/v1/me", headers: user.headers })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/v1/me", headers: { authorization: `Bearer ${fresh.session}` } }))
        .statusCode,
    ).toBe(200);
    expect((await store.sessionPrincipal(agent.session, device))!.expiresAt).toBe(agent.expiresAt);
    expect(
      await store.touchSession((await store.sessionPrincipal(agent.session, device))!.sessionHash!),
    ).toBeNull();
  } finally {
    await app.close();
  }
});

it("closes idle sockets even when transport pongs continue", async () => {
  const store = await RelayStore.open(),
    account = await testAccount(store),
    session = await store.createSession(account.id);
  const ticket = await store.ticket((await store.sessionPrincipal(session.session))!);
  const app = await createRelay({ store, heartbeatMs: 20 });
  let peer: WsPeer | undefined;
  try {
    const base = await app.listen();
    peer = await WsPeer.open(base.replace("http:", "ws:") + "/v1/ws/client");
    peer.send({ type: "client.authenticate", ticket: ticket.ticket });
    await peer.wait((m) => m.type === "client.authenticated");
    peer.socket.pong();
    expect((await store.sessionPrincipal(session.session))!.expiresAt).toBe(session.expiresAt);
    await store.query("UPDATE sessions SET expires_at=$2 WHERE hash=$1", [
      hash(session.session),
      Date.now() - 1,
    ]);
    expect(await peer.closed).toBe(4003);
  } finally {
    peer?.socket.terminate();
    await app.close();
  }
});
it("persists policy changes without reviving expired logins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "go-session-policy-"));
  let store: RelayStore | undefined;
  try {
    store = await RelayStore.open(undefined, dir);
    const user = await testAccount(store);
    const session = await store.createSession(user.id);
    await store.query("UPDATE sessions SET expires_at=$2 WHERE hash=$1", [
      hash(session.session),
      Date.now() - 1,
    ]);
    await store.setAuthSettings({ idleTimeoutMinutes: 1440 });
    expect(await store.sessionPrincipal(session.session)).toBeNull();
    await store.close();
    store = await RelayStore.open(undefined, dir);
    expect(await store.authSettings()).toEqual({ idleTimeoutMinutes: 1440 });
  } finally {
    await store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
