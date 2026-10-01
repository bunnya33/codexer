import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { tokenBreakdownSchema, turnTokenUsageSchema } from "../../../packages/protocol/src/index.js";
import type { HistoryPage, RemoteThread, TokenBreakdown, TurnTokenUsage } from "../../../packages/protocol/src/index.js";
import { boundHistoryPage, boundThread, record } from "../../../packages/codex-adapter/src/normalize.js";

type Observation = { turnId: string | null; idle: boolean; baseline: TokenBreakdown | null; completeCoverage: boolean; firstNotification: boolean; model?: string };
const counters = ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "cacheWriteInputTokens", "reasoningOutputTokens"] as const;
function breakdown(value: unknown): TokenBreakdown | null {
  const parsed = tokenBreakdownSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function same(left: TokenBreakdown, right: TokenBreakdown): boolean { return counters.every(key => (left[key] ?? 0) === (right[key] ?? 0)); }

export class UsageJournal {
  private readonly db: DatabaseSync;
  private readonly observations = new Map<string, Observation>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS turn_usage (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(thread_id,turn_id))");
    this.db.exec("UPDATE turn_usage SET value=json_set(value,'$.state','partial') WHERE json_extract(value,'$.state')='running'");
  }

  get(threadId: string, turnId: string): TurnTokenUsage | undefined {
    const row = this.db.prepare("SELECT value FROM turn_usage WHERE thread_id=? AND turn_id=?").get(threadId, turnId);
    if (typeof row?.value !== "string") return undefined;
    const parsed = turnTokenUsageSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : undefined;
  }
  private save(threadId: string, turnId: string, usage: TurnTokenUsage): boolean {
    const parsed = turnTokenUsageSchema.safeParse(usage);
    if (!parsed.success) return false;
    this.db.prepare("INSERT INTO turn_usage(thread_id,turn_id,value) VALUES(?,?,?) ON CONFLICT(thread_id,turn_id) DO UPDATE SET value=excluded.value").run(threadId, turnId, JSON.stringify(parsed.data));
    return true;
  }

  startTurn(threadId: string, turnId: string, model?: string | null): void {
    const prior = this.observations.get(threadId);
    if (prior?.turnId === turnId && !prior.idle) return;
    this.observations.set(threadId, { turnId, idle: false, baseline: prior?.baseline ?? null, completeCoverage: true, firstNotification: true, ...(model ? { model } : {}) });
  }

  finishTurn(threadId: string, turnId: string): void {
    const observation = this.observations.get(threadId);
    if (!observation || observation.turnId !== turnId) return;
    observation.idle = true;
    const usage = this.get(threadId, turnId);
    const state = observation.completeCoverage ? "complete" : "partial";
    if (usage?.state === "complete" && state === "partial") return;
    if (usage && usage.state !== state) this.save(threadId, turnId, { ...usage, state });
  }

  gap(threadId?: string): void {
    for (const [id, observation] of this.observations) {
      if (threadId && id !== threadId) continue;
      if (!observation.idle && observation.turnId) {
        const usage = this.get(id, observation.turnId);
        if (usage) this.save(id, observation.turnId, { ...usage, state: "partial" });
      }
      this.observations.delete(id);
    }
  }

  observeDesktop(thread: RemoteThread): void {
    if (!thread.ownerAvailable) { this.gap(thread.id); return; }
    if (thread.status === "active" && !thread.activeTurnId) {
      // Desktop inserts a temporary turn before assigning its official ID.
      if (!this.observations.has(thread.id)) this.observations.set(thread.id, { turnId: null, idle: false, baseline: breakdown(record(thread.tokenUsage).total), completeCoverage: false, firstNotification: false });
      return;
    }
    const turnId = thread.activeTurnId ?? thread.turns.at(-1)?.id ?? null;
    const idle = thread.status !== "active";
    const total = breakdown(record(thread.tokenUsage).total);
    let observation = this.observations.get(thread.id);
    if (!observation) {
      // A follower snapshot is a baseline, not usage attributable to its latest turn.
      this.observations.set(thread.id, { turnId, idle, baseline: total, completeCoverage: false, firstNotification: false });
      return;
    }
    if (turnId !== observation.turnId) {
      const previousTurnId = observation.turnId;
      const skipped = previousTurnId !== null && !thread.turns.some(turn => turn.id === previousTurnId);
      observation = { turnId, idle, baseline: observation.baseline, completeCoverage: observation.idle && !idle, firstNotification: false,
        ...(thread.settings?.model ? { model: thread.settings.model } : {}) };
      if (skipped) { observation.baseline = total; observation.completeCoverage = false; }
      this.observations.set(thread.id, observation);
    }
    if (turnId && total) this.update(thread.id, turnId, thread.tokenUsage, false);
    if (turnId && idle) this.finishTurn(thread.id, turnId);
    else observation.idle = idle;
  }

  observeNotification(threadId: string, turnId: string, tokenUsage: unknown): void {
    const total = breakdown(record(tokenUsage).total);
    if (!total) return;
    let observation = this.observations.get(threadId);
    if (!observation) {
      observation = { turnId, idle: true, baseline: total, completeCoverage: false, firstNotification: false };
      this.observations.set(threadId, observation);
      return;
    }
    if (observation.turnId !== turnId) {
      // Restored usage can be emitted before turn/started; never charge it to a new turn.
      if (!observation.idle) return;
      observation.turnId = turnId;
      observation.baseline = total;
      observation.completeCoverage = false;
      observation.firstNotification = false;
      return;
    }
    this.update(threadId, turnId, tokenUsage, true);
  }

  private update(threadId: string, turnId: string, value: unknown, notification: boolean): void {
    const observation = this.observations.get(threadId)!;
    const usage = record(value);
    const total = breakdown(usage.total);
    const last = breakdown(usage.last);
    if (!total) return;
    const baseline = observation.baseline;
    if (baseline && same(total, baseline)) return;
    let delta: TokenBreakdown;
    if (baseline) {
      if (counters.some(key => (total[key] ?? 0) < (baseline[key] ?? 0))) {
        observation.completeCoverage = false;
        observation.baseline = total;
        observation.firstNotification = false;
        const previous = this.get(threadId, turnId);
        if (previous) this.save(threadId, turnId, { ...previous, state: "partial" });
        return;
      }
      delta = Object.fromEntries(counters.map(key => [key, (total[key] ?? 0) - (baseline[key] ?? 0)])) as TokenBreakdown;
    } else if (last && observation.completeCoverage && (notification && observation.firstNotification || same(total, last))) {
      delta = last;
    } else {
      observation.completeCoverage = false;
      observation.baseline = total;
      observation.firstNotification = false;
      return;
    }
    observation.baseline = total;
    observation.firstNotification = false;
    const previous = this.get(threadId, turnId);
    const counts = Object.fromEntries(counters.map(key => [key, (previous?.[key] ?? 0) + (delta[key] ?? 0)])) as TokenBreakdown;
    const model = previous?.model ?? observation.model;
    if (!this.save(threadId, turnId, { ...counts, state: observation.completeCoverage ? observation.idle ? "complete" : "running" : "partial",
      ...(model ? { model } : {}) })) {
      observation.completeCoverage = false;
      if (previous) this.save(threadId, turnId, { ...previous, state: "partial" });
    }
  }

  enrichThread(thread: RemoteThread): RemoteThread {
    return boundThread({ ...thread, requests: [...thread.requests], turns: thread.turns.map(turn => {
      const tokenUsage = this.get(thread.id, turn.id);
      return { ...turn, items: [...turn.items], plan: [...turn.plan], ...(tokenUsage ? { tokenUsage } : {}) };
    }) });
  }
  enrichHistory(page: HistoryPage): HistoryPage {
    return boundHistoryPage({ ...page, turns: page.turns.map(turn => {
      const tokenUsage = this.get(page.threadId, turn.id);
      return { ...turn, items: [...turn.items], ...(tokenUsage ? { tokenUsage } : {}) };
    }) });
  }
  close(): void { this.db.close(); }
}
