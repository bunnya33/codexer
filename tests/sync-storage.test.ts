import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_THREADS } from "../packages/protocol/src/index.js";
import type { DeviceSnapshot, RemoteEvent, RemoteThread } from "../packages/protocol/src/index.js";
import { openDatabase } from "../apps/relay/src/storage/database.js";
import { migrateDatabase } from "../apps/relay/src/storage/migrations.js";
import type { Database } from "../apps/relay/src/storage/types.js";
import { SyncRepository } from "../apps/relay/src/sync/repository.js";
import { WeixinStore } from "../apps/relay/src/weixin/repository.js";
import { event, snapshot } from "./helpers.js";

describe("per-thread snapshot persistence", () => {
  let database: Database;
  let sync: SyncRepository;

  beforeEach(async () => {
    database = await openDatabase();
    await migrateDatabase(database);
    const weixin = new WeixinStore(database.sql, database.transaction);
    await weixin.initialize();
    sync = new SyncRepository(database.sql, database.transaction, weixin);
    await database.sql.query(
      "INSERT INTO devices(id,name,platform,created_at) VALUES($1,'Test','win32',0)",
      ["device-test"],
    );
  });

  afterEach(async () => database.close());

  function update(state: DeviceSnapshot, thread: RemoteThread): RemoteEvent {
    return { ...event(state), change: { type: "thread.updated", thread } };
  }

  function withSecondThread(): DeviceSnapshot {
    const state = snapshot();
    state.threads["thread-other"] = {
      ...state.threads["thread-test"]!,
      id: "thread-other",
      title: "Other",
    };
    return state;
  }

  it("assembles the original snapshot while storing metadata and thread rows separately", async () => {
    const state = withSecondThread();
    await sync.saveSnapshot(state);
    expect(await sync.snapshot(state.deviceId)).toEqual(state);

    const head = (await database.sql.query("SELECT payload FROM snapshots")).rows[0]!.payload;
    expect(head).not.toHaveProperty("threads");
    const rows = (
      await database.sql.query("SELECT thread_id,payload FROM snapshot_threads ORDER BY thread_id")
    ).rows;
    expect(rows.map((row) => row.thread_id)).toEqual(["thread-other", "thread-test"]);
    expect(rows[0]!.payload).toEqual(state.threads["thread-other"]);
  });

  it("does not rewrite unchanged threads or copy their data into metadata during an event", async () => {
    const state = withSecondThread();
    await sync.saveSnapshot(state);
    // A database guard fails the transaction if the hot path touches an unrelated thread.
    await database.sql
      .query(`CREATE FUNCTION guard_thread_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.thread_id='thread-other' THEN RAISE EXCEPTION 'unrelated-thread-write'; END IF;
        RETURN NEW;
      END $$`);
    await database.sql.query(
      "CREATE TRIGGER unchanged_thread BEFORE UPDATE OR DELETE ON snapshot_threads FOR EACH ROW EXECUTE FUNCTION guard_thread_write()",
    );

    const thread = { ...state.threads["thread-test"]!, title: "Updated" };
    await sync.saveEvent(update(state, thread));
    const next = (await sync.snapshot(state.deviceId))!;
    expect(next).toEqual({
      ...state,
      lastSeq: 1,
      generatedAt: next.generatedAt,
      threads: { ...state.threads, "thread-test": thread },
    });
    expect((await sync.snapshotMetadata(state.deviceId))!).not.toHaveProperty("threads");

    await sync.saveEvent(event(next, false));
    expect((await sync.snapshot(state.deviceId))!.threads).toEqual(next.threads);
    expect((await sync.snapshot(state.deviceId))!.runtime.connected).toBe(false);
  });

  it("migrates legacy full snapshots and preserves event replay without resurrecting deleted threads", async () => {
    const state = withSecondThread();
    await database.sql.query(
      "INSERT INTO snapshots(device_id,epoch,seq,payload) VALUES($1,$2,$3,$4::jsonb)",
      [state.deviceId, state.epoch, state.lastSeq, JSON.stringify(state)],
    );
    const first = event(state, false);
    await database.sql.query(
      "INSERT INTO events(device_id,epoch,seq,payload,created_at) VALUES($1,$2,1,$3::jsonb,$4)",
      [state.deviceId, state.epoch, JSON.stringify(first), Date.now()],
    );
    const legacy = {
      ...state,
      lastSeq: 1,
      generatedAt: first.timestamp,
      runtime: { ...state.runtime, connected: false },
    };
    await database.sql.query("UPDATE snapshots SET seq=1,payload=$2::jsonb WHERE device_id=$1", [
      state.deviceId,
      JSON.stringify(legacy),
    ]);

    await migrateDatabase(database);
    expect(await sync.snapshot(state.deviceId)).toEqual(legacy);
    expect(await sync.replay(state.deviceId, state.epoch, 0)).toEqual([first]);

    await sync.saveEvent({
      ...event(legacy),
      change: { type: "thread.removed", threadId: "thread-other" },
    });
    await migrateDatabase(database);
    expect(Object.keys((await sync.snapshot(state.deviceId))!.threads)).toEqual(["thread-test"]);
    expect((await sync.snapshotMetadata(state.deviceId))!.lastSeq).toBe(2);
  });

  it("rolls back migration thread inserts if removing the legacy payload fails", async () => {
    const state = withSecondThread();
    await database.sql.query(
      "INSERT INTO snapshots(device_id,epoch,seq,payload) VALUES($1,$2,0,$3::jsonb)",
      [state.deviceId, state.epoch, JSON.stringify(state)],
    );
    await database.sql
      .query(`CREATE FUNCTION fail_metadata_migration() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'migration-failed'; END $$`);
    await database.sql.query(
      "CREATE TRIGGER fail_migration BEFORE UPDATE ON snapshots FOR EACH ROW EXECUTE FUNCTION fail_metadata_migration()",
    );

    await expect(migrateDatabase(database)).rejects.toThrow("migration-failed");
    expect((await database.sql.query("SELECT payload FROM snapshots")).rows[0]!.payload).toEqual(
      state,
    );
    expect((await database.sql.query("SELECT * FROM snapshot_threads")).rows).toEqual([]);

    await database.sql.query("DROP TRIGGER fail_migration ON snapshots");
    await migrateDatabase(database);
    expect(await sync.snapshot(state.deviceId)).toEqual(state);
  });

  it("replaces old threads on a new epoch and rejects snapshots behind the current sequence", async () => {
    const state = withSecondThread();
    await sync.saveSnapshot(state);
    await sync.saveEvent(update(state, { ...state.threads["thread-test"]!, title: "New title" }));
    await expect(sync.saveSnapshot(state)).rejects.toThrow("stale-snapshot");
    expect((await sync.snapshot(state.deviceId))!.threads["thread-test"]!.title).toBe("New title");

    const replacement = { ...snapshot(state.deviceId, "new-epoch"), threads: {} };
    await sync.saveSnapshot(replacement);
    expect(await sync.snapshot(state.deviceId)).toEqual(replacement);
    expect(await sync.replay(state.deviceId, state.epoch, 0)).toBeNull();
  });

  it("keeps metadata, thread state and replay unchanged after a sequence conflict", async () => {
    const state = withSecondThread();
    await sync.saveSnapshot(state);
    const invalid = {
      ...update(state, { ...state.threads["thread-test"]!, title: "Invalid" }),
      seq: 3,
    };
    await expect(sync.saveEvent(invalid)).rejects.toThrow("sequence-gap");
    expect(await sync.snapshot(state.deviceId)).toEqual(state);
    expect(await sync.replay(state.deviceId, state.epoch, 0)).toEqual([]);

    const first = update(state, { ...state.threads["thread-test"]!, title: "Committed" });
    const results = await Promise.allSettled([sync.saveEvent(first), sync.saveEvent(first)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await sync.snapshotMetadata(state.deviceId))!.lastSeq).toBe(1);
    expect(await sync.replay(state.deviceId, state.epoch, 0)).toEqual([first]);
  });

  it("enforces the total thread limit even though event processing only loads one thread", async () => {
    const state = snapshot();
    const template = state.threads["thread-test"]!;
    state.threads = Object.fromEntries(
      Array.from({ length: MAX_THREADS }, (_, index) => [
        `thread-${index}`,
        { ...template, id: `thread-${index}` },
      ]),
    );
    await sync.saveSnapshot(state);
    await expect(
      sync.saveEvent(update(state, { ...template, id: "thread-extra" })),
    ).rejects.toThrow("thread-limit");
    expect(await sync.snapshot(state.deviceId)).toEqual(state);

    await sync.saveEvent(
      update(state, { ...template, id: "thread-0", title: "Existing thread updated" }),
    );
    const next = (await sync.snapshot(state.deviceId))!;
    await sync.saveEvent({
      ...event(next),
      change: { type: "thread.removed", threadId: "thread-1" },
    });
    await sync.saveEvent(
      update((await sync.snapshot(state.deviceId))!, { ...template, id: "thread-extra" }),
    );
    expect(Object.keys((await sync.snapshot(state.deviceId))!.threads)).toHaveLength(MAX_THREADS);
  });
});
