import { testAccount, testAgent } from "./account-helpers.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RelayStore } from "../apps/relay/src/store.js";
import { command, event, snapshot } from "./helpers.js";

describe("relay persistence", () => {
  let store: RelayStore, deviceId: string, token: string, principal: Awaited<ReturnType<RelayStore["sessionPrincipal"]>>;
  beforeAll(async () => {
    store = await RelayStore.open();
    const account = await testAccount(store);
    const registered = await testAgent(store, account.id); deviceId = registered.id; token = registered.token;
    principal = await store.sessionPrincipal(account.session);
  });
  afterAll(async () => store.close());
  it("requires exact device credentials and consumes tickets once", async () => {
    expect(await store.authorizeDevice(deviceId, "wrong-token")).toBe(false);
    expect(await store.authorizeDevice(deviceId, token)).toBe(true);
    const { ticket } = await store.ticket(principal!);
    expect(await store.consumeTicket(ticket)).toEqual(principal);
    expect(await store.consumeTicket(ticket)).toBeNull();
  });
  it("atomically persists ordered events and rolls back a sequence gap", async () => {
    const state = snapshot(deviceId, "epoch-order");
    await store.saveSnapshot(state);
    const first = event(state);
    const next = await store.saveEvent(first);
    await expect(store.saveEvent({ ...first, seq: 3 })).rejects.toThrow("sequence-gap");
    expect((await store.snapshot(deviceId))?.lastSeq).toBe(1);
    await store.saveEvent(event(next, true));
    expect((await store.replay(deviceId, state.epoch, 0))?.map(value => value.seq)).toEqual([1, 2]);
  });
  it("falls back to a snapshot when replay is incomplete or an epoch changed", async () => {
    const state = { ...snapshot(deviceId, "epoch-missing-events"), lastSeq: 10 };
    await store.saveSnapshot(state);
    expect(await store.replay(deviceId, state.epoch, 0)).toBeNull();
    expect(await store.replay(deviceId, "old-epoch", 10)).toBeNull();
    expect(await store.replay(deviceId, state.epoch, 10)).toEqual([]);
    await expect(store.saveSnapshot({ ...state, lastSeq: 9 })).rejects.toThrow("stale-snapshot");
  });
  it("fences late command results after a final result is committed", async () => {
    const input = command({ type: "turn.start", threadId: "thread-test", text: "test" }, snapshot(deviceId));
    await store.addCommand(input);
    const result = { deviceId, commandId: input.commandId, status: "succeeded" as const, code: "ok" };
    expect(await store.finishCommand(result)).toBe(true);
    expect(await store.finishCommand({ ...result, status: "unknown" })).toBe(false);
    expect((await store.command(deviceId, input.commandId))?.result).toEqual(result);
  });
  it("revocation removes authentication and cached state access", async () => {
    await store.revoke(deviceId);
    expect(await store.authorizeDevice(deviceId, token)).toBe(false);
    expect(await store.snapshot(deviceId)).toBeNull();
  });
});

it("creates a fresh nested data directory, retains snapshots, and marks pending outcomes unknown after restart", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "codex-remote-relay-store-"));
  const directory = join(rootDirectory, "nested", "relay");
  let store = await RelayStore.open(undefined, directory);
  try {
    const account = await testAccount(store);
    const registered = await testAgent(store, account.id); const deviceId = registered.id;
    const state = snapshot(deviceId);
    const input = command({ type: "turn.start", threadId: "thread-test", text: "test" }, state);
    await store.saveSnapshot(state); await store.addCommand(input); await store.close();
    store = await RelayStore.open(undefined, directory);
    expect((await store.snapshot(deviceId))?.epoch).toBe(state.epoch);
    expect(await store.authorizeDevice(deviceId, registered.token)).toBe(true);
    expect((await store.command(deviceId, input.commandId))?.result).toMatchObject({ status: "unknown", code: "relay-restarted" });
  } finally { await store.close(); await rm(rootDirectory, { recursive: true, force: true }); }
});
