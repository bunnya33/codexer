import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import type { Database } from "./types.js";
import { performance } from "node:perf_hooks";
import type { RelayMetrics } from "../observability/metrics.js";
import type { Sql } from "./types.js";

function instrumentDatabase(database: Database, metrics?: RelayMetrics): Database {
  if (!metrics) return database;

  const instrumentSql = (source: Sql): Sql => ({
    query: async (text, params) => {
      const startedAt = performance.now();
      let failed = false;
      try {
        return await source.query(text, params);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        metrics.observeDatabase(performance.now() - startedAt, failed);
      }
    },
  });

  return {
    sql: instrumentSql(database.sql),
    transaction: async (operation) => {
      const startedAt = performance.now();
      let failed = false;
      try {
        return await database.transaction((sql) => operation(instrumentSql(sql)));
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        metrics.observeTransaction(performance.now() - startedAt, failed);
      }
    },
    close: () => database.close(),
  };
}

/** 数据库运行方式不影响功能模块：PGlite 自建或外部 PostgreSQL。 */
export async function openDatabase(
  databaseUrl?: string,
  directory?: string,
  metrics?: RelayMetrics,
): Promise<Database> {
  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl });
    return instrumentDatabase(
      {
        sql: pool,
        transaction: async (operation) => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const result = await operation(client);
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
        },
        close: () => pool.end(),
      },
      metrics,
    );
  }
  if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
  const db = new PGlite(directory);
  await db.waitReady;
  return instrumentDatabase(
    {
      sql: db,
      transaction: (operation) => db.transaction((tx) => operation(tx)),
      close: () => db.close(),
    },
    metrics,
  );
}
