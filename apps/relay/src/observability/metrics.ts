import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { CleanupSummary } from "../storage/batch-cleanup.js";

export type QueueLane = "device" | "exclusive" | "maintenance";

const BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000];

/** 固定数量的桶，避免按请求、账号或设备保存样本导致指标本身占用无界内存。 */
class DurationHistogram {
  private count = 0;
  private totalMs = 0;
  private maxMs = 0;
  private readonly buckets = new Array<number>(BUCKETS_MS.length + 1).fill(0);

  observe(durationMs: number): void {
    const value = Math.max(0, durationMs);
    this.count++;
    this.totalMs += value;
    this.maxMs = Math.max(this.maxMs, value);
    const index = BUCKETS_MS.findIndex((bound) => value <= bound);
    this.buckets[index < 0 ? BUCKETS_MS.length : index]!++;
  }

  snapshot() {
    const percentile = (fraction: number) => {
      if (!this.count) return 0;
      let count = 0;
      for (let index = 0; index < this.buckets.length; index++) {
        count += this.buckets[index]!;
        if (count >= Math.ceil(this.count * fraction)) return BUCKETS_MS[index] ?? this.maxMs;
      }
      return this.maxMs;
    };

    return {
      count: this.count,
      meanMs: this.count ? this.totalMs / this.count : 0,
      maxMs: this.maxMs,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      buckets: this.buckets.map((count, index) => ({ upperMs: BUCKETS_MS[index] ?? null, count })),
    };
  }
}

export class RelayMetrics {
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private loopBaseline = performance.eventLoopUtilization();
  private started = false;
  private readonly database = new DurationHistogram();
  private readonly transactions = new DurationHistogram();
  private readonly http = new DurationHistogram();
  private readonly events = new DurationHistogram();
  private readonly broadcast = new DurationHistogram();
  private readonly cleanup = new DurationHistogram();
  private readonly queueWait = Object.fromEntries(
    ["device", "exclusive", "maintenance"].map((lane) => [lane, new DurationHistogram()]),
  ) as Record<QueueLane, DurationHistogram>;
  private readonly queueRun = Object.fromEntries(
    ["device", "exclusive", "maintenance"].map((lane) => [lane, new DurationHistogram()]),
  ) as Record<QueueLane, DurationHistogram>;
  private databaseErrors = 0;
  private transactionErrors = 0;
  private eventErrors = 0;
  private httpErrors = 0;
  private broadcastRecipients = 0;
  private sentMessages = 0;
  private sentBytes = 0;
  private backpressureCloses = 0;
  private oversizedCloses = 0;
  private cleanupErrors = 0;
  private cleanupDeleted = 0;
  private cleanupCappedRuns = 0;
  private lastCleanup: {
    finishedAt: number;
    failed: boolean;
    deletedRows: number;
    tables: CleanupSummary | null;
  } | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loopBaseline = performance.eventLoopUtilization();
    this.loop.enable();
  }

  stop(): void {
    this.loop.disable();
    this.started = false;
  }

  observeQueue(lane: QueueLane, phase: "wait" | "run", durationMs: number): void {
    (phase === "wait" ? this.queueWait : this.queueRun)[lane].observe(durationMs);
  }

  observeDatabase(durationMs: number, failed: boolean): void {
    this.database.observe(durationMs);
    if (failed) this.databaseErrors++;
  }

  observeTransaction(durationMs: number, failed: boolean): void {
    this.transactions.observe(durationMs);
    if (failed) this.transactionErrors++;
  }

  observeHttp(durationMs: number, status: number): void {
    this.http.observe(durationMs);
    if (status >= 500) this.httpErrors++;
  }

  observeEvent(durationMs: number, failed: boolean): void {
    this.events.observe(durationMs);
    if (failed) this.eventErrors++;
  }

  observeBroadcast(durationMs: number, recipients: number): void {
    this.broadcast.observe(durationMs);
    this.broadcastRecipients += recipients;
  }

  observeSend(bytes: number): void {
    this.sentMessages++;
    this.sentBytes += bytes;
  }

  observeClose(reason: "backpressure" | "payload-too-large"): void {
    if (reason === "backpressure") this.backpressureCloses++;
    else this.oversizedCloses++;
  }

  observeCleanup(
    durationMs: number,
    deleted: number,
    failed: boolean,
    summary?: CleanupSummary,
  ): void {
    this.cleanup.observe(durationMs);
    this.cleanupDeleted += deleted;
    if (failed) this.cleanupErrors++;
    if (summary && Object.values(summary).some((table) => table.capped)) this.cleanupCappedRuns++;
    this.lastCleanup = {
      finishedAt: Date.now(),
      failed,
      deletedRows: deleted,
      tables: summary ?? null,
    };
  }

  snapshot() {
    const milliseconds = (value: number) => (Number.isFinite(value) ? value / 1e6 : 0);

    return {
      capturedAt: Date.now(),
      process: {
        uptimeSeconds: process.uptime(),
        memoryBytes: process.memoryUsage(),
        cpuMicroseconds: process.cpuUsage(),
        eventLoop: {
          monitoring: this.started,
          utilization: performance.eventLoopUtilization(this.loopBaseline).utilization,
          delayMeanMs: milliseconds(this.loop.mean),
          delayMaxMs: milliseconds(this.loop.max),
          delayP95Ms: milliseconds(this.loop.percentile(95)),
          delayP99Ms: milliseconds(this.loop.percentile(99)),
        },
      },
      database: {
        queries: this.database.snapshot(),
        errors: this.databaseErrors,
        transactions: this.transactions.snapshot(),
        transactionErrors: this.transactionErrors,
      },
      queues: Object.fromEntries(
        ["device", "exclusive", "maintenance"].map((lane) => [
          lane,
          {
            wait: this.queueWait[lane as QueueLane].snapshot(),
            run: this.queueRun[lane as QueueLane].snapshot(),
          },
        ]),
      ),
      http: { requests: this.http.snapshot(), serverErrors: this.httpErrors },
      events: { processing: this.events.snapshot(), errors: this.eventErrors },
      transport: {
        broadcast: this.broadcast.snapshot(),
        broadcastRecipients: this.broadcastRecipients,
        sentMessages: this.sentMessages,
        sentBytes: this.sentBytes,
        backpressureCloses: this.backpressureCloses,
        oversizedCloses: this.oversizedCloses,
      },
      cleanup: {
        runs: this.cleanup.snapshot(),
        deletedRows: this.cleanupDeleted,
        errors: this.cleanupErrors,
        cappedRuns: this.cleanupCappedRuns,
        lastRun: this.lastCleanup,
      },
    };
  }
}
