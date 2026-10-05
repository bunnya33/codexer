import { expect, it } from "vitest";
import { createRelay } from "../apps/relay/src/server.js";
import { RelayStore } from "../apps/relay/src/storage/store.js";
import { testAccount, testAgent } from "./account-helpers.js";
import { event, snapshot } from "./helpers.js";

it("exposes aggregate metrics only to admins and records real query/event failures without payloads", async () => {
  const store = await RelayStore.open();
  const admin = await testAccount(store, "MetricsAdmin", "admin");
  const user = await testAccount(store, "MetricsUser");
  const device = await testAgent(store, user.id);
  const app = await createRelay({ store });
  try {
    expect((await app.inject({ url: "/v1/admin/metrics" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/admin/metrics", headers: user.headers })).statusCode).toBe(
      403,
    );
    const state = snapshot(device.id);
    await store.saveSnapshot(state);
    await store.saveEvent(event(state));
    await expect(store.saveEvent(event(state))).rejects.toThrow("sequence-gap");
    await expect(store.createUser("MetricsUser", "test-password-123456")).rejects.toThrow();
    await store.cleanup();

    const response = await app.inject({ url: "/v1/admin/metrics", headers: admin.headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const metrics = response.json();
    expect(metrics.database.queries.count).toBeGreaterThan(0);
    expect(metrics.database.errors).toBe(1);
    expect(metrics.database.transactionErrors).toBe(1);
    expect(metrics.events).toMatchObject({ processing: { count: 2 }, errors: 1 });
    expect(metrics.cleanup.runs.count).toBe(1);
    expect(metrics.http.requests.count).toBeGreaterThanOrEqual(2);
    expect(metrics.process.memoryBytes.rss).toBeGreaterThan(0);
    expect(metrics.process.eventLoop.monitoring).toBe(true);
    expect(Number.isFinite(metrics.process.eventLoop.delayMeanMs)).toBe(true);
    for (const secret of [
      user.id,
      device.id,
      user.session,
      admin.session,
      "MetricsUser",
      "test-password-123456",
      "SELECT",
      "thread-test",
    ]) {
      expect(response.body).not.toContain(secret);
    }
  } finally {
    await app.close();
  }
  expect(store.metrics.snapshot().process.eventLoop.monitoring).toBe(false);
});
