import { describe, expect, it } from "vitest";
import { normalizeThread, normalizeHistoryTurn } from "../packages/codex-adapter/src/normalize.js";
import { HeadlessAdapter } from "../packages/codex-adapter/src/headless.js";
import { collectSubAgents } from "../packages/codex-adapter/src/sub-agents.js";
import {
  conversationSubAgents,
  mergeSubAgents,
  subAgentCounts,
} from "../packages/client-shared/src/sub-agents.js";
import {
  historyTurnSchema,
  jsonBytes,
  MAX_SUB_AGENTS,
  MAX_THREAD_BYTES,
  threadSchema,
} from "../packages/protocol/src/index.js";

const spawn = (threadId = "child", state: string | undefined = "running") => ({
  id: `spawn-${threadId}`,
  type: "collabAgentToolCall",
  tool: "spawnAgent",
  status: "completed",
  senderThreadId: "parent",
  receiverThreadIds: [threadId],
  agentsStates: state ? { [threadId]: { status: state, message: null } } : {},
  prompt: "Check concurrency",
});
const raw = (items: unknown[]) => ({
  id: "parent",
  title: "Parent",
  threadRuntimeStatus: { type: "active" },
  turns: [{ id: "turn", status: "inProgress", items }],
});

describe("sub Agent observation", () => {
  it("uses agent states rather than the tool status and preserves supported states through transport schemas", () => {
    for (const status of [
      "pendingInit",
      "running",
      "interrupted",
      "completed",
      "errored",
      "shutdown",
      "notFound",
    ]) {
      const thread = threadSchema.parse(normalizeThread(raw([spawn("child", status)]), 1));
      expect(thread.subAgents![0]).toMatchObject({
        status,
        task: "Check concurrency",
        parentThreadId: "parent",
      });
      expect(thread.turns[0]!.items[0]!.subAgents![0]!.status).toBe(status);
      const history = historyTurnSchema.parse(
        normalizeHistoryTurn({ id: "turn", items: [spawn("child", status)] }, undefined, "parent"),
      );
      expect(history.items[0]!.subAgents![0]!.status).toBe(status);
    }
    expect(normalizeThread(raw([{ ...spawn(), agentsStates: {} }]), 0).subAgents![0]!.status).toBe(
      "unknown",
    );
    expect(normalizeThread(raw([spawn("child", "futureStatus")]), 0).subAgents![0]!.status).toBe(
      "unknown",
    );
    expect(normalizeThread(raw([{ ...spawn(), status: "failed" }]), 0).subAgents![0]!.status).toBe(
      "running",
    );
  });

  it("retains agents whose creation records are outside the live item and turn windows", () => {
    const thread = normalizeThread(
      {
        ...raw([]),
        turns: [
          { id: "old", items: [spawn()] },
          { id: "middle", items: [] },
          {
            id: "now",
            items: Array.from({ length: 25 }, (_, index) => ({
              id: `${index}`,
              type: "commandExecution",
              command: "test",
            })),
          },
        ],
      },
      0,
    );
    expect(thread.turns.flatMap((turn) => turn.items).some((item) => item.subAgents)).toBe(false);
    expect(thread.subAgents![0]!.threadId).toBe("child");
  });

  it("merges repeated activity and metadata without turning a message into a running task", () => {
    const items = [
      spawn(),
      {
        type: "subAgentActivity",
        agentThreadId: "child",
        kind: "completed",
        agentPath: "/root/layout",
      },
      { type: "subAgentActivity", agentThreadId: "child", kind: "interacted" },
      spawn("parent"),
    ];
    const thread = normalizeThread(raw(items), 1);
    expect(thread.subAgents).toHaveLength(1);
    expect(thread.subAgents![0]).toMatchObject({
      status: "completed",
      path: "/root/layout",
      task: "Check concurrency",
    });
    const updated = mergeSubAgents(thread.subAgents!, [
      { threadId: "child", name: "Reviewer", status: "running", statusSource: "thread" },
    ]);
    expect(updated[0]).toMatchObject({
      name: "Reviewer",
      task: "Check concurrency",
      status: "running",
    });
  });

  it("combines loaded history with the newer live summary and clears old results on restart", () => {
    const history = normalizeHistoryTurn(
      {
        id: "turn",
        items: [
          {
            ...spawn("child", "completed"),
            agentsStates: { child: { status: "completed", message: "Done" } },
          },
        ],
      },
      undefined,
      "parent",
    );
    const thread = normalizeThread(raw([spawn("child", "running")]), 3);
    const agents = conversationSubAgents(thread, [history]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("running");
    expect(agents[0]!.message).toBeUndefined();
    expect(subAgentCounts(agents)).toEqual({ total: 1, running: 1, pending: 0, errors: 0 });
    expect(threadSchema.safeParse({ ...thread, subAgents: [...agents, ...agents] }).success).toBe(
      false,
    );
  });

  it("bounds long and numerous agent records while keeping active agents", () => {
    const items = Array.from({ length: MAX_SUB_AGENTS + 6 }, (_, index) => ({
      ...spawn(`child-${index}`, index < MAX_SUB_AGENTS ? "completed" : "running"),
      prompt: "\u0001".repeat(4000),
    }));
    const result = collectSubAgents([{ items }], "parent");
    expect(result.subAgents).toHaveLength(MAX_SUB_AGENTS);
    expect(result.subAgentsTruncated).toBe(true);
    expect(result.subAgents.filter((agent) => agent.status === "running")).toHaveLength(6);
    const thread = normalizeThread(raw(items), 0);
    expect(jsonBytes(thread)).toBeLessThanOrEqual(MAX_THREAD_BYTES);
    expect(threadSchema.safeParse(thread).success).toBe(true);
    expect(thread.subAgents!.every((agent) => agent.truncated)).toBe(true);
  });

  it("reads descendant runtime status through the headless API without starting or resuming children", async () => {
    const adapter = new HeadlessAdapter();
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let status = "active";
    let includeSpawn = true;
    const rpc = {
      stop: async () => {},
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "thread/read")
          return { thread: { id: "parent", status: { type: "active" } } };
        if (method === "thread/turns/list")
          return {
            data: [{ id: "turn", status: "inProgress", items: includeSpawn ? [spawn()] : [] }],
            nextCursor: null,
          };
        if (method === "thread/items/list") return { data: [], nextCursor: null };
        if (method === "thread/list")
          return {
            data: [
              {
                id: "child",
                parentThreadId: "parent",
                agentNickname: "Reviewer",
                status: { type: status },
              },
            ],
            nextCursor: null,
          };
        throw new Error(method);
      },
    };
    Object.assign(adapter, { connected: true, rpc });
    try {
      expect(await adapter.follow("parent")).toBe(true);
      expect(adapter.getThread("parent")!.subAgents![0]).toMatchObject({
        name: "Reviewer",
        status: "running",
        statusSource: "thread",
      });
      status = "systemError";
      expect(await adapter.follow("parent")).toBe(true);
      expect(adapter.getThread("parent")!.subAgents![0]!.status).toBe("errored");
      includeSpawn = false;
      adapter.unfollow("parent");
      expect(await adapter.follow("parent")).toBe(true);
      expect(adapter.getThread("parent")!.subAgents![0]).toMatchObject({
        threadId: "child",
        status: "errored",
        name: "Reviewer",
      });
      expect(calls.find((call) => call.method === "thread/list")!.params).toMatchObject({
        ancestorThreadId: "parent",
        limit: MAX_SUB_AGENTS + 1,
      });
      expect(calls.every((call) => !["thread/resume", "turn/start"].includes(call.method))).toBe(
        true,
      );
    } finally {
      await adapter.stop();
    }
  });

  it("keeps reported states when an older headless version rejects descendant queries", async () => {
    const adapter = new HeadlessAdapter();
    const rpc = {
      stop: async () => {},
      request: async (method: string) => {
        if (method === "thread/read") return { thread: { id: "parent", status: { type: "idle" } } };
        if (method === "thread/turns/list")
          return {
            data: [{ id: "turn", items: [spawn("child", "interrupted")] }],
            nextCursor: null,
          };
        if (method === "thread/items/list") return { data: [], nextCursor: null };
        throw new Error("Unsupported filter");
      },
    };
    Object.assign(adapter, { connected: true, rpc });
    try {
      expect(await adapter.follow("parent")).toBe(true);
      expect(adapter.getThread("parent")!.subAgents![0]).toMatchObject({
        status: "interrupted",
        statusSource: "reported",
      });
    } finally {
      await adapter.stop();
    }
  });
});
