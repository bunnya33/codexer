import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { SubAgentRollouts } from "../packages/codex-adapter/src/sub-agent-rollouts.js";
import { DesktopAdapter } from "../packages/codex-adapter/src/desktop.js";
import { desktopTurns } from "../packages/codex-adapter/src/normalize.js";
import { FakeDesktop, waitFor } from "./helpers.js";
import { threadSchema } from "../packages/protocol/src/index.js";
import type { RemoteSubAgent } from "../packages/protocol/src/index.js";

const child = "01a0ec60-050f-7723-b899-579c526c0b12";
const agent: RemoteSubAgent = {
  threadId: child,
  parentThreadId: "parent",
  status: "unknown",
  statusSource: "activity",
};
const directories: string[] = [];
const line = (value: unknown) => JSON.stringify(value) + "\n";
const event = (payload: unknown, ordinal?: number) => ({ type: "event_msg", payload, ordinal });
const response = (payload: unknown, ordinal?: number) => ({
  type: "response_item",
  payload,
  ordinal,
});
const message = (role: string, text: string) =>
  response({
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  });
async function fixture(parentId = "parent", records: unknown[] = [], extraMeta = {}) {
  const home = await mkdtemp(join(tmpdir(), "codexer-subagents-"));
  directories.push(home);
  const directory = join(home, "sessions", "2026", "10", "09");
  await mkdir(directory, { recursive: true });
  const file = join(directory, "rollout-2026-10-09T10-00-00-" + child + ".jsonl");
  await writeFile(
    file,
    [
      {
        type: "session_meta",
        payload: {
          id: child,
          parent_thread_id: parentId,
          agent_nickname: "Reviewer",
          agent_path: "/root/review",
          ...extraMeta,
        },
      },
      ...records,
    ]
      .map(line)
      .join(""),
  );
  return { home, file, reader: new SubAgentRollouts(home) };
}
afterEach(async () => {
  for (const home of directories.splice(0)) {
    const within = relative(tmpdir(), home);
    if (!within.startsWith("codexer-subagents-") || isAbsolute(within))
      throw new Error("invalid test cleanup path");
    await rm(home, { recursive: true, force: true });
  }
});

describe("child rollout details", () => {
  it("supplements native activity-only records with visible progress, metadata and final results", async () => {
    const { reader } = await fixture("parent", [
      event({ type: "task_started" }),
      message("user", "Review concurrency"),
      { type: "turn_context", payload: { model: "test-model" } },
      message("assistant", "Checking the queue"),
      event({ type: "task_complete", last_agent_message: "Queue review completed" }),
    ]);
    expect(await reader.refresh("parent", [agent])).toBe(true);
    expect(reader.enrich("parent", [agent])[0]).toMatchObject({
      name: "Reviewer",
      path: "/root/review",
      model: "test-model",
      task: "Review concurrency",
      status: "completed",
      message: "Queue review completed",
      statusSource: "activity",
    });
    expect(await reader.refresh("parent", [agent])).toBe(false);
  });

  it("ignores inherited history, environment instructions, encrypted blocks and hidden reasoning", async () => {
    const { reader } = await fixture(
      "parent",
      [
        { ...message("user", "Parent private task"), ordinal: 1 },
        event({ type: "task_complete", last_agent_message: "Parent result" }, 2),
        event({ type: "task_started" }, 10),
        response(
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "# AGENTS.md instructions" },
              {
                type: "input_text",
                text: "<environment_context>instructions</environment_context>",
              },
            ],
            internal_chat_message_metadata_passthrough: {
              content_item_kinds: ["agents_md.instructions", "environments.environment_context"],
            },
          },
          11,
        ),
        response(
          {
            type: "agent_message",
            content: [
              {
                type: "input_text",
                text: "Message Type: NEW_TASK\nTask name: /root/review\nSender: /root\nPayload:\n",
              },
              { type: "encrypted_content", encrypted_content: "PRIVATE_CIPHERTEXT" },
            ],
          },
          12,
        ),
        response(
          { type: "reasoning", content: [{ type: "output_text", text: "HIDDEN_REASONING" }] },
          13,
        ),
      ],
      { subagent_history_start_ordinal: 10 },
    );
    await reader.refresh("parent", [agent]);
    const result = reader.enrich("parent", [agent])[0]!;
    expect(result.status).toBe("running");
    expect(result.task).toBeUndefined();
    expect(result.message).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_CIPHERTEXT|HIDDEN_REASONING|Parent private task|Parent result/,
    );
  });

  it("reads available plaintext native task payloads and never replaces an existing official prompt", async () => {
    const { reader } = await fixture("parent", [
      response({
        type: "agent_message",
        content: [
          {
            type: "input_text",
            text: "Message Type: NEW_TASK\nTask name: /root/review\nSender: /root\nPayload:\nReview retry handling",
          },
        ],
      }),
    ]);
    await reader.refresh("parent", [agent]);
    expect(reader.enrich("parent", [agent])[0]!.task).toBe("Review retry handling");
    expect(reader.enrich("parent", [{ ...agent, task: "Official latest prompt" }])[0]!.task).toBe(
      "Official latest prompt",
    );
  });

  it("verifies child identity and parent ownership instead of trusting a filename", async () => {
    const { file, reader } = await fixture("wrong-parent", [
      message("assistant", "Other parent message"),
    ]);
    expect(await reader.refresh("parent", [agent])).toBe(false);
    expect(reader.enrich("parent", [agent])).toEqual([agent]);
    await writeFile(
      file,
      line({ type: "session_meta", payload: { id: "wrong-child", parent_thread_id: "parent" } }) +
        line(message("assistant", "Other child message")),
    );
    expect(await reader.refresh("parent", [agent])).toBe(false);
    expect(reader.enrich("parent", [agent])).toEqual([agent]);
  });

  it("bounds huge records and reads the latest tail without reusing a status from skipped history", async () => {
    const { reader } = await fixture("parent", [
      message("user", "Initial review"),
      event({ type: "task_complete", last_agent_message: "Old result" }),
      response({ type: "command_execution", output: "x".repeat(1024 * 1024) }),
      event({ type: "task_complete", last_agent_message: "New result ".repeat(500) }),
    ]);
    await reader.refresh("parent", [agent]);
    const result = reader.enrich("parent", [agent])[0]!;
    expect(result.message?.startsWith("New result")).toBe(true);
    expect(result.message!.length).toBe(2000);
    expect(result.truncated).toBe(true);
    expect(result.task).toBe("Initial review");
  });

  it("ignores partial writer lines, clears old replies on restart, and keeps shutdown status", async () => {
    const { reader, file } = await fixture("parent", [
      event({ type: "task_complete", last_agent_message: "Old completed result" }),
    ]);
    await reader.refresh("parent", [agent]);
    await appendFile(file, line(event({ type: "task_started" })) + '{"type":"event_msg"');
    await reader.refresh("parent", [agent]);
    const restarted = reader.enrich("parent", [{ ...agent, message: "Stale reply" }])[0]!;
    expect(restarted.status).toBe("running");
    expect(restarted.message).toBeUndefined();
    expect(reader.enrich("parent", [{ ...agent, status: "shutdown" }])[0]!.status).toBe("shutdown");
    reader.forget("parent");
    expect(reader.enrich("parent", [agent])).toEqual([agent]);
  });

  it("publishes child-only progress to the desktop adapter without a new parent snapshot or command", async () => {
    const { home, file } = await fixture("thread-test", [
      event({ type: "task_started" }),
      message("assistant", "Reviewing"),
    ]);
    const desktop = new FakeDesktop();
    desktopTurns(desktop.state)[0]!.items = [
      {
        type: "subAgentActivity",
        id: "spawn",
        kind: "started",
        agentThreadId: child,
        agentPath: "/root/review",
      },
    ];
    await desktop.start();
    const adapter = new DesktopAdapter(desktop.endpoint, home);
    const emitted: string[] = [];
    adapter.on("thread", (value) => {
      if (value) emitted.push(JSON.stringify(value));
    });
    try {
      await adapter.connect();
      expect(await adapter.follow("thread-test")).toBe(true);
      await waitFor(
        () => adapter.getThread("thread-test")?.subAgents?.[0]?.message === "Reviewing",
      );
      await appendFile(
        file,
        line(event({ type: "task_complete", last_agent_message: "Review passed" })),
      );
      await adapter.refreshSubAgents();
      await waitFor(() => emitted.some((value) => value.includes("Review passed")));
      const result = threadSchema.parse(adapter.getThread("thread-test"));
      expect(result.subAgents![0]).toMatchObject({
        status: "completed",
        message: "Review passed",
        name: "Reviewer",
      });
      expect(desktop.revision).toBe(0);
      expect(
        desktop.received.some((value) => String(value.method).startsWith("thread-follower-")),
      ).toBe(false);
    } finally {
      adapter.stop();
      await desktop.close();
    }
  });
});
