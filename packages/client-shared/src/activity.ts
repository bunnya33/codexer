import type { HistoryTurn, RemoteItem } from "../../protocol/src/index.js";

export type ActivityBlock = {
  kind: "activity";
  id: string;
  items: RemoteItem[];
  state: "running" | "completed" | "interrupted" | "failed" | "recorded";
  startedAtMs?: number;
  durationMs?: number;
};
export type ConversationBlock = { kind: "message"; item: RemoteItem } | ActivityBlock;

export function completedTurnBlocks(turn: HistoryTurn): ConversationBlock[] {
  return buildActivityBlocks(turn, false);
}

export function messageRole(item: RemoteItem): "user" | "assistant" | undefined {
  const type = item.type.toLowerCase();
  if (type === "usermessage" || type === "user" || type === "steeringusermessage") return "user";
  if (type === "agentmessage" || type === "assistantmessage" || type === "assistant") return "assistant";
  return undefined;
}

export function itemDuration(item: RemoteItem): number | undefined {
  if (item.durationMs !== undefined) return item.durationMs;
  if (item.startedAtMs !== undefined && item.completedAtMs !== undefined && item.completedAtMs >= item.startedAtMs) return item.completedAtMs - item.startedAtMs;
  return undefined;
}

export function formatDuration(durationMs: number): string {
  if (durationMs > 0 && durationMs < 1000) return "不到1秒";
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return `${hours ? `${hours}小时` : ""}${minutes ? `${minutes}分钟` : ""}${rest || !hours && !minutes ? `${rest}秒` : ""}`;
}

export function activityLabel(block: ActivityBlock, nowMs = Date.now()): string {
  const duration = block.state === "running" && block.startedAtMs !== undefined ? Math.max(0, nowMs - block.startedAtMs) : block.durationMs;
  const elapsed = duration === undefined ? "" : ` ${formatDuration(duration)}`;
  if (block.state === "running") return `正在处理${elapsed}`;
  if (block.state === "interrupted") return `已停止${duration === undefined ? "" : ` · 用时${elapsed}`}`;
  if (block.state === "failed") return `处理失败${elapsed}`;
  if (block.state === "recorded") return "处理记录";
  return duration === undefined ? "处理记录" : `已处理${elapsed}`;
}

export function buildActivityBlocks(turn: HistoryTurn, isActive: boolean): ConversationBlock[] {
  const first = turn.items[0];
  const initialUser = first && messageRole(first) === "user" && first.type.toLowerCase() !== "steeringusermessage" ? first : undefined;
  const process = initialUser ? turn.items.slice(1) : turn.items;
  const running = isActive && turn.status === "inProgress";
  const state = running ? "running" : turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "failed" : "recorded";
  const startedAtMs = turn.startedAtMs ?? initialUser?.completedAtMs ?? initialUser?.startedAtMs ?? turn.previousMessage?.completedAtMs ?? turn.previousMessage?.startedAtMs ?? process[0]?.startedAtMs;
  const durationMs = turn.durationMs ?? (startedAtMs !== undefined && turn.completedAtMs !== undefined && turn.completedAtMs >= startedAtMs ? turn.completedAtMs - startedAtMs : undefined);
  const activity: ActivityBlock = { kind: "activity", id: `${turn.id}:work`, items: process, state,
    ...(startedAtMs !== undefined ? { startedAtMs } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
  return [...(initialUser ? [{ kind: "message" as const, item: initialUser }] : []),
    ...(process.length || durationMs !== undefined || running ? [activity] : [])];
}

export function mergeLiveTurn(history: HistoryTurn, live: HistoryTurn): HistoryTurn {
  if (history.status === "completed" && live.status !== "completed" && history.items.some(item => item.phase === "final_answer")) return { ...history, ...(live.tokenUsage ? { tokenUsage: live.tokenUsage } : {}) };
  const previous = new Map(history.items.map(item => [item.id, item]));
  const items = live.items.map(item => {
    const recorded = previous.get(item.id);
    if (recorded && messageRole(item) === "user" && item.truncated && (recorded.text?.length ?? 0) > (item.text?.length ?? 0)) return { ...item, ...recorded };
    // Completed history has larger text/output limits than a live snapshot.
    if (history.status === "completed" && live.status === "completed" && recorded && item.truncated) return { ...item, ...recorded };
    return { ...recorded, ...item };
  });
  const changes = new Map((history.fileChanges ?? []).map(change => [change.path, change]));
  for (const change of live.fileChanges ?? []) {
    const previous = changes.get(change.path);
    const delta = change.additions + change.deletions - (previous ? previous.additions + previous.deletions : 0);
    if (!previous || delta > 0 || delta === 0 && change.diff.length > previous.diff.length) changes.set(change.path, change);
  }
  const merged = { ...history, ...live, ...(changes.size ? { fileChanges: [...changes.values()] } : {}) };
  if (!live.itemsTruncatedBefore) return { ...merged, items, truncated: Boolean(live.itemsTruncatedAfter || items.some(item => item.truncated)) };
  const incoming = new Map(items.map(item => [item.id, item]));
  const combined = history.items.map(item => incoming.get(item.id) ?? item);
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (combined.some(existing => existing.id === item.id)) continue;
    const next = items.slice(index + 1).find(candidate => combined.some(existing => existing.id === candidate.id));
    const previous = [...items.slice(0, index)].reverse().find(candidate => combined.some(existing => existing.id === candidate.id));
    const position = next ? combined.findIndex(existing => existing.id === next.id) : previous ? combined.findIndex(existing => existing.id === previous.id) + 1 : combined.length;
    combined.splice(position, 0, item);
  }
  return { ...merged, previousMessage: history.previousMessage ?? live.previousMessage, itemsTruncatedBefore: history.itemsTruncatedBefore ?? false, itemsTruncatedAfter: live.itemsTruncatedAfter ?? false,
    items: combined, truncated: Boolean(history.truncated || live.truncated || combined.some(item => item.truncated)) };
}
