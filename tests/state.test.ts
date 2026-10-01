import { describe, expect, it } from "vitest";
import { FrameDecoder, encodeFrame } from "../packages/codex-adapter/src/framing.js";
import { desktopTurns, normalizeThread, record } from "../packages/codex-adapter/src/normalize.js";
import { jsonBytes, MAX_THREAD_BYTES, reduceEvent, snapshotSchema, threadSchema } from "../packages/protocol/src/index.js";
import { event, rawThread, snapshot } from "./helpers.js";

describe("IPC framing", () => {
  it("reassembles fragmented headers and UTF-8 and decodes combined frames", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ text: "\u6d4b\u8bd5" });
    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2, 14))).toEqual([]);
    expect(decoder.push(Buffer.concat([frame.subarray(14), encodeFrame({ next: true })]))).toEqual([{ text: "\u6d4b\u8bd5" }, { next: true }]);
  });
  it("rejects zero and excessive lengths before allocating a complete frame", () => {
    expect(() => new FrameDecoder().push(Buffer.alloc(4))).toThrow("invalid-ipc-frame-length");
    const frame = Buffer.alloc(4); frame.writeUInt32LE(33);
    expect(() => new FrameDecoder(32).push(frame)).toThrow("invalid-ipc-frame-length");
  });
  it("rejects invalid JSON", () => {
    expect(() => new FrameDecoder().push(Buffer.from([1, 0, 0, 0, 123]))).toThrow();
  });
});

describe("authoritative desktop state", () => {
  it("reads canonical history and never treats historical inProgress as live", () => {
    const state = rawThread("idle");
    expect(desktopTurns(state)).toHaveLength(1);
    expect(normalizeThread(state, 3)).toMatchObject({ status: "idle", activeTurnId: null, revision: 3 });
    expect(normalizeThread(rawThread(), 3).activeTurnId).toBe("turn-A");
  });
  it("preserves plans, command output and diffs from canonical turn items", () => {
    const state = rawThread(), turn = desktopTurns(state)[0]!;
    turn.items = [{ id: "plan", type: "todo-list", plan: [{ step: "Test", status: "inProgress" }] }, { id: "cmd", type: "commandExecution", command: "npm test", aggregatedOutput: "result", status: "completed" }];
    turn.diff = "diff example";
    const thread = normalizeThread(state, 2);
    expect(thread.turns[0]).toMatchObject({ plan: [{ step: "Test", status: "inProgress" }], diff: "diff example" });
    expect(thread.turns[0]?.items[1]).toMatchObject({ command: "npm test", output: "result" });
    expect(threadSchema.safeParse(thread).success).toBe(true);
  });
  it("bounds escaped outputs and request details and marks unsupported responses", () => {
    const state = rawThread(), turn = desktopTurns(state)[0]!;
    turn.items = Array.from({ length: 40 }, (_, index) => ({ id: String(index), type: "commandExecution", aggregatedOutput: "\u0000".repeat(20000), changes: Array.from({ length: 40 }, () => ({ path: "x".repeat(1000) })) }));
    state.requests = [{ id: 12, method: "item/tool/requestUserInput", params: { turnId: "turn-A", questions: ["x".repeat(20000)] } }, { id: 13, method: "item/permissions/requestApproval", params: { turnId: "turn-A", permissions: {} } }];
    const thread = normalizeThread(state, 1);
    expect(jsonBytes(thread)).toBeLessThanOrEqual(MAX_THREAD_BYTES);
    expect(thread.turns[0]?.truncated).toBe(true);
    expect(thread.requests[0]).toMatchObject({ id: "12", respondable: false, detailsTruncated: true });
    expect(thread.requests[1]?.respondable).toBe(false);
    expect(threadSchema.safeParse(thread).success).toBe(true);
  });
  it("does not infer active state from unknown runtime values", () => {
    expect(normalizeThread(rawThread("future-value"), 0).status).toBe("unavailable");
    expect(record(null)).toEqual({});
  });
  it("blocks approvals when the displayed command is truncated", () => {
    const state = rawThread();
    state.requests = [{ id: 15, method: "item/commandExecution/requestApproval", params: { turnId: "turn-A", command: "x".repeat(20000) } }];
    expect(normalizeThread(state, 0).requests[0]).toMatchObject({ respondable: false, detailsTruncated: true });
  });
});

describe("remote reconciliation", () => {
  it("updates the runtime kind when the Agent switches to headless app-server", () => {
    const state = snapshot();
    const next = reduceEvent(state, { ...event(state), change: { type: "runtime.status", connected: true, kind: "official-app-server" } });
    expect(next.runtime).toMatchObject({ kind: "official-app-server", connected: true });
    expect(snapshotSchema.safeParse(next).success).toBe(true);
  });
  it("rejects sequence gaps, duplicate events and old epochs", () => {
    const state = snapshot(), update = event(state);
    const next = reduceEvent(state, update);
    expect(next.lastSeq).toBe(1);
    expect(() => reduceEvent(next, update)).toThrow("sequence-gap");
    expect(() => reduceEvent(state, { ...update, seq: 2 })).toThrow("sequence-gap");
    expect(() => reduceEvent(state, { ...update, epoch: "previous" })).toThrow("sequence-gap");
  });
  it("removes evicted threads and enforces the snapshot thread bound", () => {
    const state = snapshot();
    const next = reduceEvent(state, { ...event(state), change: { type: "thread.removed", threadId: "thread-test" } });
    expect(next.threads).toEqual({});
    for (let index = 0; index < 19; index++) state.threads[String(index)] = { ...state.threads["thread-test"]!, id: String(index) };
    expect(() => reduceEvent(state, { ...event(state), change: { type: "thread.updated", thread: { ...state.threads["thread-test"]!, id: "extra" } } })).toThrow("thread-limit");
    expect(snapshotSchema.safeParse(state).success).toBe(true);
  });
});
