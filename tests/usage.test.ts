import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageJournal } from "../apps/pc-agent/src/usage.js";
import { boundHistoryPage, normalizeHistoryTurn, normalizeThread } from "../packages/codex-adapter/src/normalize.js";
import { historyPageSchema, jsonBytes, MAX_CATALOG_BYTES, MAX_THREAD_BYTES, threadSchema } from "../packages/protocol/src/index.js";
import type { TokenBreakdown } from "../packages/protocol/src/index.js";

const counts = (input: number, output: number, cached: number): TokenBreakdown => ({ totalTokens: input + output, inputTokens: input, outputTokens: output, cachedInputTokens: cached });
const info = (total: TokenBreakdown, last = total) => ({ total, last });
const thread = (turnId: string, status: string, tokenUsage: unknown, previousId = "old") => normalizeThread({ id: "thread", latestModel: "model-a", threadRuntimeStatus: { type: status }, latestTokenUsageInfo: tokenUsage, turns: [{ id: previousId, status: "completed", items: [] }, { id: turnId, status: status === "active" ? "inProgress" : "completed", items: [] }] }, 0);

describe("per-turn token journal", () => {
  it("uses cumulative deltas for a whole turn, deduplicates repeated last-call counters and joins history", () => {
    const journal = new UsageJournal(":memory:");
    try {
      const old = counts(1000, 100, 500);
      journal.observeDesktop(thread("old", "idle", info(old)));
      journal.observeDesktop(thread("new", "active", info(old)));
      journal.observeDesktop(thread("new", "active", info(counts(1500, 130, 900), counts(500, 30, 400))));
      journal.observeDesktop(thread("new", "active", info(counts(1900, 150, 1200), counts(400, 20, 300))));
      journal.observeDesktop(thread("new", "idle", info(counts(1900, 150, 1200), counts(400, 20, 300))));
      expect(journal.get("thread", "old")).toBeUndefined();
      expect(journal.get("thread", "new")).toMatchObject({ inputTokens: 900, outputTokens: 50, cachedInputTokens: 700, totalTokens: 950, model: "model-a", state: "complete" });
      const page = journal.enrichHistory({ threadId: "thread", turns: [{ id: "new", status: "completed", items: [], truncated: false }], nextCursor: null, generatedAt: 0 });
      expect(page.turns[0]?.tokenUsage).toEqual(journal.get("thread", "new"));
      journal.observeDesktop(thread("next", "active", info(counts(1900, 150, 1200)), "new"));
      expect(journal.get("thread", "next")).toBeUndefined();
    } finally { journal.close(); }
  });
  it("marks observation started mid-turn and connection gaps as partial", () => {
    const journal = new UsageJournal(":memory:");
    try {
      journal.observeDesktop(thread("new", "active", info(counts(1500, 130, 900))));
      journal.observeDesktop(thread("new", "active", info(counts(1900, 150, 1200))));
      journal.gap();
      journal.observeDesktop(thread("new", "active", info(counts(2500, 180, 1600))));
      journal.observeDesktop(thread("new", "idle", info(counts(2700, 190, 1700))));
      expect(journal.get("thread", "new")).toMatchObject({ inputTokens: 600, outputTokens: 30, cachedInputTokens: 400, state: "partial" });
    } finally { journal.close(); }
  });
  it("keeps the baseline across the desktop's temporary turn without an official ID", () => {
    const journal = new UsageJournal(":memory:");
    try {
      const old = counts(1000, 100, 500);
      journal.observeDesktop(thread("old", "idle", info(old)));
      journal.observeDesktop(normalizeThread({ id: "thread", threadRuntimeStatus: { type: "active" }, latestTokenUsageInfo: info(old), turns: [{ id: "old", status: "completed", items: [] }, { status: "inProgress", items: [] }] }, 0));
      journal.observeDesktop(thread("new", "active", info(old)));
      journal.observeDesktop(thread("new", "idle", info(counts(1500, 130, 900))));
      expect(journal.get("thread", "unknown")).toBeUndefined();
      expect(journal.get("thread", "new")).toMatchObject({ inputTokens: 500, outputTokens: 30, cachedInputTokens: 400, state: "complete" });
    } finally { journal.close(); }
  });
  it("does not attribute skipped turns or reset cumulative counters to the current turn", () => {
    const journal = new UsageJournal(":memory:");
    try {
      journal.observeDesktop(thread("old", "idle", info(counts(1000, 100, 500))));
      journal.observeDesktop(thread("new", "active", info(counts(1900, 150, 1200)), "unobserved"));
      expect(journal.get("thread", "new")).toBeUndefined();
      journal.observeDesktop(thread("new", "active", info(counts(2000, 160, 1250)), "unobserved"));
      journal.observeDesktop(thread("new", "active", info(counts(100, 10, 50)), "unobserved"));
      journal.observeDesktop(thread("new", "idle", info(counts(200, 20, 100)), "unobserved"));
      expect(journal.get("thread", "new")).toMatchObject({ inputTokens: 200, outputTokens: 20, cachedInputTokens: 100, state: "partial" });
    } finally { journal.close(); }
  });
  it("tracks official notifications from the first call with their turn IDs", () => {
    const journal = new UsageJournal(":memory:");
    try {
      journal.startTurn("thread", "new", "model-b");
      journal.observeNotification("thread", "new", info(counts(1500, 130, 900), counts(500, 30, 400)));
      journal.observeNotification("thread", "new", info(counts(1500, 130, 900), counts(500, 30, 400)));
      journal.observeNotification("thread", "other", info(counts(1600, 140, 950)));
      journal.observeNotification("thread", "new", info(counts(1900, 150, 1200), counts(400, 20, 300)));
      journal.finishTurn("thread", "new");
      expect(journal.get("thread", "new")).toMatchObject({ inputTokens: 900, outputTokens: 50, cachedInputTokens: 700, state: "complete", model: "model-b" });
      expect(journal.get("thread", "other")).toBeUndefined();
    } finally { journal.close(); }
  });
  it("marks counters that cannot be attributed consistently to one turn as partial", () => {
    const journal = new UsageJournal(":memory:");
    try {
      journal.observeDesktop(thread("old", "idle", info(counts(1000, 100, 500))));
      journal.observeDesktop(thread("new", "active", info(counts(1000, 100, 600))));
      journal.observeDesktop(thread("new", "idle", info(counts(1500, 130, 900))));
      expect(journal.get("thread", "new")).toMatchObject({ inputTokens: 500, outputTokens: 30, cachedInputTokens: 300, state: "partial" });
    } finally { journal.close(); }
  });
  it("persists completed records and makes unfinished records partial after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-usage-"));
    let journal = new UsageJournal(join(dir, "usage.sqlite"));
    try {
      journal.startTurn("thread", "done"); journal.observeNotification("thread", "done", info(counts(100, 10, 50))); journal.finishTurn("thread", "done");
      journal.startTurn("thread", "running"); journal.observeNotification("thread", "running", info(counts(300, 30, 100)));
      journal.close(); journal = new UsageJournal(join(dir, "usage.sqlite"));
      expect(journal.get("thread", "done")?.state).toBe("complete");
      expect(journal.get("thread", "running")).toMatchObject({ inputTokens: 200, outputTokens: 20, state: "partial" });
      journal.observeDesktop(thread("done", "idle", info(counts(100, 10, 50))));
      journal.observeDesktop(thread("done", "idle", info(counts(100, 10, 50))));
      expect(journal.get("thread", "done")?.state).toBe("complete");
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("keeps usage inside live and history transport budgets without mutating adapter data", () => {
    const journal = new UsageJournal(":memory:");
    try {
      journal.startTurn("thread", "new"); journal.observeNotification("thread", "new", info(counts(100, 10, 50))); journal.finishTurn("thread", "new");
      const large = normalizeThread({ id: "thread", threadRuntimeStatus: { type: "idle" }, turns: [{ id: "new", status: "completed", items: Array.from({ length: 20 }, (_, i) => ({ id: `item-${i}`, type: "commandExecution", text: "x".repeat(4096), aggregatedOutput: "x".repeat(8192) })) }] }, 1);
      large.turns[0]!.diff = "x".repeat(MAX_THREAD_BYTES - jsonBytes(large));
      expect(threadSchema.safeParse(large).success).toBe(true);
      const enriched = journal.enrichThread(large);
      expect(threadSchema.safeParse(enriched).success).toBe(true);
      expect(enriched.turns[0]?.tokenUsage?.state).toBe("complete");
      expect(enriched.turns[0]?.items.length).toBeLessThan(20);
      expect(large.turns[0]?.items).toHaveLength(20);
      const longTurn = (id: string, length: number) => normalizeHistoryTurn({ id, status: "completed", items: Array.from({ length }, (_, i) => ({ id: `${id}-${i}`, type: "agentMessage", text: "x".repeat(32000), aggregatedOutput: "x".repeat(32000) })) });
      const page = boundHistoryPage({ threadId: "thread", turns: [longTurn("new", 50), longTurn("other", 49), normalizeHistoryTurn({ id: "filler", status: "completed", items: [{ id: "filler", type: "agentMessage", text: "" }] })], nextCursor: null, generatedAt: 0 });
      page.turns[2]!.items[0]!.text = "x".repeat(MAX_CATALOG_BYTES - jsonBytes(page) - 10);
      expect(historyPageSchema.safeParse(page).success).toBe(true);
      const beforeItems = page.turns.reduce((total, turn) => total + turn.items.length, 0);
      const enrichedPage = journal.enrichHistory(page);
      expect(historyPageSchema.safeParse(enrichedPage).success).toBe(true);
      expect(enrichedPage.turns[0]?.tokenUsage?.state).toBe("complete");
      expect(enrichedPage.turns.reduce((total, turn) => total + turn.items.length, 0)).toBeLessThan(beforeItems);
      expect(page.turns.reduce((total, turn) => total + turn.items.length, 0)).toBe(beforeItems);
    } finally { journal.close(); }
  });
});
