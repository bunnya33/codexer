import { MAX_SUB_AGENTS } from "../../protocol/src/index.js";
import type { HistoryTurn, RemoteSubAgent, RemoteThread } from "../../protocol/src/index.js";

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
