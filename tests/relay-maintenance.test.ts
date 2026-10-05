import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelay } from "../apps/relay/src/server.js";
import { RelayStore } from "../apps/relay/src/storage/store.js";
import { openDatabase } from "../apps/relay/src/storage/database.js";
import { migrateDatabase } from "../apps/relay/src/storage/migrations.js";
import { cleanupStorage } from "../apps/relay/src/storage/maintenance.js";
import { deleteInBatches } from "../apps/relay/src/storage/batch-cleanup.js";
import type { CleanupSummary } from "../apps/relay/src/storage/batch-cleanup.js";
import type { Database, Sql } from "../apps/relay/src/storage/types.js";
import { WeixinStore } from "../apps/relay/src/weixin/repository.js";

describe("bounded cleanup batches", () => {
  let database: Database;
  let weixin: WeixinStore;

  beforeEach(async () => {
    database = await openDatabase();
    await migrateDatabase(database);
    weixin = new WeixinStore(database.sql, database.transaction);
    await weixin.initialize();
    await database.sql.query(
      "INSERT INTO users(id,name,password_hash,created_at) VALUES('user-test','Test','test-hash',0)",
    );
    await database.sql.query(
      "INSERT INTO devices(id,name,platform,created_at,revoked_at) VALUES('device-test','Test','win32',0,NULL),('revoked-device','Old','win32',0,1)",
    );
    await weixin.bind({
      id: "binding-test",
      userId: "user-test",
      botId: "bot-test",
      peerId: "peer-test",
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "test-secret",
    });
  });

  afterEach(async () => database.close());

  it("limits each cleanup pass, finishes later passes and preserves live rows, pending notices and command deduplication", async () => {
    const now = Date.now();
    await database.sql.query(
      "INSERT INTO events SELECT 'device-test','epoch',i,'{}'::jsonb,$1 FROM generate_series(1,123) AS i",
      [now - 2 * 86400000],
    );
    await database.sql.query(
      "INSERT INTO events VALUES('device-test','epoch',124,'{}'::jsonb,$1)",
      [now],
    );
    await database.sql.query(
      "INSERT INTO tickets(hash,expires_at) VALUES('expired',$1),('live',$2)",
      [now - 1000, now + 60000],
    );
    await database.sql.query(
      "INSERT INTO sessions(hash,user_id,expires_at,last_active_at) VALUES('expired','user-test',$1,0),('live','user-test',$2,0)",
      [now - 1000, now + 60000],
    );
    await database.sql.query(
      "INSERT INTO commands(device_id,id,payload_hash,status,expires_at,created_at) VALUES('device-test','dedup','hash','pending',0,0)",
    );
    await database.sql.query(
      `INSERT INTO images(device_id,thread_id,id,payload,bytes,uploaded,expires_at,created_at) VALUES
      ('device-test','thread','expired','{}',1,TRUE,$1,0),
      ('device-test','thread','live','{}',1,TRUE,$2,0),
      ('device-test','thread','retained','{}',1,TRUE,NULL,0),
      ('revoked-device','thread','revoked','{}',1,TRUE,NULL,0)`,
      [now - 1000, now + 60000],
    );
    await database.sql.query(
      `INSERT INTO weixin_outbox(binding_id,id,kind,text,client_id,state,next_attempt_at,created_at) VALUES
      ('binding-test','old-sent','test','Test','a','sent',0,$1),
      ('binding-test','old-pending','test','Test','b','pending',0,$1),
      ('binding-test','new-sent','test','Test','c','sent',0,$2)`,
      [now - 31 * 86400000, now],
    );
    await database.sql.query(
      "INSERT INTO weixin_inbox(binding_id,id,created_at) VALUES('binding-test','old',$1),('binding-test','live',$2)",
      [now - 31 * 86400000, now],
    );

    const first = await cleanupStorage(database.sql, weixin, { batchSize: 25, maxBatches: 2 });
    expect(first.events).toMatchObject({ deleted: 50, batches: 2, capped: true });
    const second = await cleanupStorage(database.sql, weixin, { batchSize: 25, maxBatches: 10 });
    expect(second.events).toMatchObject({ deleted: 73, capped: false });
    for (const table of ["events", "tickets", "sessions", "weixin_inbox"]) {
      expect(
        (await database.sql.query(`SELECT COUNT(*) AS total FROM ${table}`)).rows[0]!.total,
      ).toBe(1);
    }
    expect(
      (await database.sql.query("SELECT id FROM images ORDER BY id")).rows.map((row) => row.id),
    ).toEqual(["live", "retained"]);
    expect(
      (await database.sql.query("SELECT id FROM weixin_outbox ORDER BY id")).rows.map(
        (row) => row.id,
      ),
    ).toEqual(["new-sent", "old-pending"]);
    expect((await database.sql.query("SELECT id,status FROM commands")).rows).toEqual([
      { id: "dedup", status: "pending" },
    ]);
  });

  it("keeps completed batches committed when a later batch fails", async () => {
    await database.sql.query("INSERT INTO tickets SELECT i::text,0 FROM generate_series(1,7) AS i");
    let batches = 0;
    const failingSql: Sql = {
      query: async (statement, params) => {
        if (++batches === 2) throw new Error("cleanup-interrupted");
        return database.sql.query(statement, params);
      },
    };
    const onBatch = vi.fn();
    await expect(
      deleteInBatches(
        failingSql,
        { table: "tickets", predicate: "expires_at<$1", orderBy: "expires_at", params: [1] },
        {
          batchSize: 3,
          onBatch,
        },
      ),
    ).rejects.toThrow("cleanup-interrupted");
    expect(onBatch.mock.calls).toEqual([[3]]);
    expect((await database.sql.query("SELECT COUNT(*) AS total FROM tickets")).rows[0]!.total).toBe(
      4,
    );
    const result = await cleanupStorage(database.sql, weixin, { batchSize: 3 });
    expect(result.tickets!.deleted).toBe(4);
  });

  it("honors shutdown cancellation before issuing new cleanup statements", async () => {
    await database.sql.query("INSERT INTO tickets VALUES('expired',0,NULL,NULL)");
    const controller = new AbortController();
    controller.abort();
    const result = await cleanupStorage(database.sql, weixin, { signal: controller.signal });
    expect(Object.values(result).every((table) => table.interrupted && table.deleted === 0)).toBe(
      true,
    );
    expect((await database.sql.query("SELECT COUNT(*) AS total FROM tickets")).rows[0]!.total).toBe(
      1,
    );
  });

  it("creates retention indexes idempotently", async () => {
    await migrateDatabase(database);
    await weixin.initialize();
    const rows = (
      await database.sql.query(
        "SELECT indexname FROM pg_indexes WHERE indexname LIKE '%cleanup' OR indexname='devices_revoked'",
      )
    ).rows;
    expect(rows.map((row) => row.indexname).sort()).toEqual([
      "devices_revoked",
      "events_cleanup",
      "images_cleanup",
      "sessions_cleanup",
      "tickets_cleanup",
      "weixin_inbox_cleanup",
      "weixin_outbox_cleanup",
    ]);
  });
});

it("retries capped cleanup without overlap and cancels further passes while draining on shutdown", async () => {
  const store = await RelayStore.open();
  const capped: CleanupSummary = {
    events: { deleted: 10000, batches: 20, capped: true, interrupted: false },
  };
  const complete: CleanupSummary = {
    events: { deleted: 1, batches: 1, capped: false, interrupted: false },
  };
  let finish: ((summary: CleanupSummary) => void) | undefined;
  let signal: AbortSignal | undefined;
  const cleanup = vi
    .spyOn(store, "cleanup")
    .mockResolvedValueOnce(capped)
    .mockImplementationOnce((options = {}) => {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    })
    .mockResolvedValue(complete);
  let app: Awaited<ReturnType<typeof createRelay>> | undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    app = await createRelay({ store, cleanupMs: 1000, cleanupRetryMs: 100, heartbeatMs: 60000 });
    await app.ready();
    await vi.advanceTimersByTimeAsync(1000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cleanup).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(cleanup).toHaveBeenCalledTimes(2);

    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(closed).toBe(false);
    finish!(complete);
    await closing;
    await vi.advanceTimersByTimeAsync(10000);
    expect(cleanup).toHaveBeenCalledTimes(2);
  } finally {
    finish?.(complete);
    vi.useRealTimers();
    cleanup.mockRestore();
    if (app) await app.close();
    else await store.close();
  }
});
