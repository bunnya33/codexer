import { MAX_SUB_AGENTS } from "../../protocol/src/index.js";
import type { RemoteSubAgent } from "../../protocol/src/index.js";
import { mergeSubAgents } from "../../client-shared/src/sub-agents.js";
import type { RecordValue } from "./normalize.js";

const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, limit: number): string | undefined =>
  typeof value === "string" && value
    ? value.slice(0, limit).toWellFormed().replaceAll("\0", "\uFFFD")
    : undefined;
const id = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 160 ? value : undefined;
const statuses = new Set([
  "pendingInit",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
]);

/** The tool call's status describes the call, never the receiving agent. */
export function itemSubAgents(value: unknown, parentThreadId: string): RemoteSubAgent[] {
  const item = record(value);
  if (item.type === "subAgentActivity") {
    const threadId = id(item.agentThreadId);
    if (!threadId || threadId === parentThreadId) return [];
    const status =
      item.kind === "started"
        ? "running"
        : item.kind === "completed"
          ? "completed"
          : item.kind === "interrupted"
            ? "interrupted"
            : "unknown";
    return [
      {
        threadId,
        parentThreadId,
        status,
        statusSource: "activity",
        ...(text(item.agentPath, 1000) ? { path: text(item.agentPath, 1000) } : {}),
      },
    ];
  }
  if (item.type !== "collabAgentToolCall") return [];
  const states = record(item.agentsStates);
  const ids = [
    ...new Set(
      [...array(item.receiverThreadIds), ...Object.keys(states)].flatMap(
        (value) => id(value) ?? [],
      ),
    ),
  ].filter((threadId) => threadId !== parentThreadId);
  const agents = ids.slice(0, MAX_SUB_AGENTS).map((threadId): RemoteSubAgent => {
    const state = record(states[threadId]);
    return {
      threadId,
      ...(id(item.senderThreadId) ? { parentThreadId: id(item.senderThreadId) } : {}),
      status: statuses.has(String(state.status))
        ? (state.status as RemoteSubAgent["status"])
        : "unknown",
      statusSource: "reported",
      ...(text(state.message, 2000) ? { message: text(state.message, 2000) } : {}),
      ...(["spawnAgent", "followupTask"].includes(String(item.tool)) && text(item.prompt, 2000)
        ? { task: text(item.prompt, 2000) }
        : {}),
      ...(text(item.model, 200) ? { model: text(item.model, 200) } : {}),
      ...([state.message, item.prompt].some(
        (value) => typeof value === "string" && value.length > 2000,
      )
        ? { truncated: true }
        : {}),
    };
  });
  return enrichSubAgents(
    agents,
    array(item.receiverThreads).map((value) => record(record(value).thread)),
  );
}

/** Desktop receiverThreads are refreshed by Codex's thread store as children change. */
export function enrichSubAgents(
  agents: RemoteSubAgent[],
  threads: RecordValue[],
): RemoteSubAgent[] {
  const metadata = new Map(
    threads.filter((thread) => id(thread.id)).map((thread) => [String(thread.id), thread]),
  );
  return agents.map((agent) => {
    const thread = metadata.get(agent.threadId);
    if (!thread) return agent;
    const runtime = record(thread.status ?? thread.threadRuntimeStatus).type;
    const status: RemoteSubAgent["status"] =
      runtime === "active"
        ? "running"
        : runtime === "systemError"
          ? "errored"
          : runtime === "idle" &&
              ["unknown", "pendingInit", "running", "idle"].includes(agent.status)
            ? "idle"
            : agent.status;
    return {
      ...agent,
      ...(id(thread.parentThreadId) ? { parentThreadId: id(thread.parentThreadId) } : {}),
      ...(text(thread.agentNickname ?? thread.name, 256)
        ? { name: text(thread.agentNickname ?? thread.name, 256) }
        : {}),
      ...(text(thread.agentRole, 256) ? { role: text(thread.agentRole, 256) } : {}),
      status,
      statusSource: ["active", "idle", "systemError"].includes(String(runtime))
        ? "thread"
        : agent.statusSource,
      ...(status === "running" ? { message: undefined } : {}),
    };
  });
}

/** Aggregate before thinning turns/items so long command output cannot hide agents. */
export function collectSubAgents(turns: RecordValue[], parentThreadId: string) {
  let agents: RemoteSubAgent[] = [];
  const receiverThreads: RecordValue[] = [];
  const seen = new Set<string>();
  for (const turn of turns)
    for (const item of array(turn.items)) {
      const raw = record(item);
      const ids =
        raw.type === "collabAgentToolCall"
          ? [...array(raw.receiverThreadIds), ...Object.keys(record(raw.agentsStates))]
          : raw.type === "subAgentActivity"
            ? [raw.agentThreadId]
            : [];
      for (const value of ids) {
        const threadId = id(value);
        if (threadId && threadId !== parentThreadId) seen.add(threadId);
      }
      const updates = itemSubAgents(item, parentThreadId);
      agents = mergeSubAgents(agents, updates);
      for (const value of array(raw.receiverThreads))
        receiverThreads.push(record(record(value).thread));
    }
  return {
    subAgents: enrichSubAgents(agents, receiverThreads),
    subAgentsTruncated: seen.size > MAX_SUB_AGENTS,
  };
}
