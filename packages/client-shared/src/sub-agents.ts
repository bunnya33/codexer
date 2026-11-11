import { MAX_SUB_AGENTS } from "../../protocol/src/index.js";
import type { HistoryTurn, RemoteSubAgent, RemoteThread, ThreadUsage } from "../../protocol/src/index.js";
import { compactTokens, estimateProjectCost, usdLabel } from './project-usage.js';

/** Updates can omit metadata. A missing status must not erase the last known state. */
export function mergeSubAgents(
  previous: RemoteSubAgent[],
  updates: RemoteSubAgent[],
): RemoteSubAgent[] {
  const agents = new Map(previous.map((agent) => [agent.threadId, agent]));
  for (const update of updates) {
    const prior = agents.get(update.threadId);
    const merged = { ...prior, ...update };
    if (merged.parentThreadId === merged.threadId) delete merged.parentThreadId;
    if (update.status === "unknown" && prior) {
      merged.status = prior.status;
      merged.statusSource = prior.statusSource;
    }
    if (["running", "pendingInit"].includes(update.status) && !update.message)
      delete merged.message;
    agents.set(update.threadId, merged);
  }
  // Keep active agents when a large history exceeds the display bound.
  return [...agents.values()]
    .sort((a, b) => Number(isSubAgentActive(b)) - Number(isSubAgentActive(a)))
    .slice(0, MAX_SUB_AGENTS);
}

export function isSubAgentActive(agent: RemoteSubAgent): boolean {
  return agent.status === "running" || agent.status === "pendingInit";
}

export function conversationSubAgents(
  thread: RemoteThread | undefined,
  turns: HistoryTurn[],
): RemoteSubAgent[] {
  let agents: RemoteSubAgent[] = [];
  for (const turn of turns)
    for (const item of turn.items) agents = mergeSubAgents(agents, item.subAgents ?? []);
  return mergeSubAgents(agents, thread?.subAgents ?? []).filter(
    (agent) => agent.threadId !== thread?.id,
  );
}

export const subAgentStatusLabel: Record<RemoteSubAgent["status"], string> = {
  pendingInit: "等待启动",
  running: "运行中",
  idle: "空闲",
  interrupted: "已中断",
  completed: "已完成",
  errored: "出错",
  shutdown: "已关闭",
  notFound: "未找到",
  unknown: "待同步",
};

export function subAgentName(agent: RemoteSubAgent): string {
  return (
    agent.name ||
    agent.path?.split("/").filter(Boolean).at(-1) ||
    `Agent ${agent.threadId.slice(-8)}`
  );
}

export function subAgentCounts(agents: RemoteSubAgent[]) {
  return {
    total: agents.length,
    running: agents.filter((agent) => agent.status === "running").length,
    pending: agents.filter((agent) => agent.status === "pendingInit").length,
    errors: agents.filter((agent) => agent.status === "errored" || agent.status === "notFound")
      .length,
  };
}

/** Child sessions only. Never add the parent's potentially overlapping counter. */
export function subAgentUsageTotal(agents: RemoteSubAgent[], truncated = false) {
  const unique = [...new Map(agents.map(agent => [agent.threadId, agent])).values()];
  const models = new Map<string, ThreadUsage['models'][number]>();
  let totalTokens = 0, recordedTokens = 0, known = 0, partial = truncated;
  for (const agent of unique) {
    const usage = agent.usage;
    if (!usage || !usage.totalKnown && !usage.recordedTokens) { partial = true; continue; }
    if (usage.totalKnown) known++;
    totalTokens += usage.totalTokens;
    recordedTokens += usage.recordedTokens;
    partial ||= usage.partial;
    for (const value of usage.models) {
      // Unknown cache-write pricing for one child must not hide another child's
      // otherwise priceable usage of the same model.
      const key = JSON.stringify([value.model, !!value.cacheWriteInputTokens]);
      const group = models.get(key) ?? { model: value.model, totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      for (const key of ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens'] as const)
        group[key] = (group[key] ?? 0) + (value[key] ?? 0);
      models.set(key, group);
    }
  }
  const usage: ThreadUsage = { totalTokens, recordedTokens, totalKnown: !truncated && known === unique.length, partial, models: [...models.values()] };
  return { usage, known, total: unique.length };
}

export function subAgentUsageLabel(usage: ThreadUsage | undefined, prefix = '会话累计'): string {
  if (!usage || !usage.totalKnown && !usage.recordedTokens) return `${prefix}用量待同步`;
  const cost = estimateProjectCost(usage);
  const tokens = `${prefix} ${usage.totalKnown ? '' : '≥'}${compactTokens(usage.totalTokens)} Token`;
  if (!cost.pricedTokens && usage.totalTokens > 0) return `${tokens} · 费用待统计`;
  return `${tokens} · ${cost.partial ? '部分预估 ' : ''}${usdLabel(cost.usd, 4)}`;
}
