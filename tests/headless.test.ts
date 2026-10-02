import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadlessAdapter, matchesSettings, savedSettings } from "../packages/codex-adapter/src/headless.js";
import { normalizeThread, record } from "../packages/codex-adapter/src/normalize.js";
import { command } from "./helpers.js";
import { parseQuestionReplies } from '../packages/protocol/src/user-presentation.js';

const directories: string[] = [];
const sessionMeta = (id: string) => JSON.stringify({ type: "session_meta", payload: { id } }) + "\n";
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("headless thread settings", () => {
  it('steers structured replies for message questions instead of answering a nonexistent RPC', async () => {
    const adapter = new HeadlessAdapter();
    const request = vi.fn().mockResolvedValue({turnId: 'turn-A'}), respond = vi.fn();
    Object.assign(adapter, {connected: true, rpc: {request, respond, stop: async () => {}}});
    vi.spyOn(adapter, 'follow').mockResolvedValue(true);
    adapter.watched.set('thread-test', normalizeThread({id: 'thread-test', threadRuntimeStatus: {type: 'active'}, turns: [{id: 'turn-A', status: 'inProgress', items: [{id: 'call-question', type: 'agentMessage', questions: [{title: 'Any requirements?', options: null}]}]}]}, 0));
    const payload = {type: 'input.respond' as const, threadId: 'thread-test', turnId: 'turn-A', requestId: 'async:call-question', answers: {'0': {answers: ['Keep the current layout']}}};
    try {
      await expect(adapter.execute(command(payload))).resolves.toMatchObject({acknowledgedByAppServer: true, turnId: 'turn-A'});
      expect(request).toHaveBeenCalledWith('turn/steer', expect.objectContaining({threadId: 'thread-test', expectedTurnId: 'turn-A'}), 30000);
      expect(parseQuestionReplies(request.mock.calls[0]![1].input[0].text)).toMatchObject([{questionItemId: JSON.stringify(['request_user_input_async', 'call-question', 0]), answer: 'Keep the current layout'}]);
      expect(respond).not.toHaveBeenCalled();
      adapter.watched.get('thread-test')!.requests = [];
      await expect(adapter.execute(command(payload))).rejects.toMatchObject({code: 'stale-request'});
    } finally { await adapter.stop(); }
  });
  it("responds to a pending async question after its originating turn and rejects stale/foreign requests", async () => {
    const adapter = new HeadlessAdapter();
    const request = {id: 42, method: "item/tool/requestUserInput", params: {threadId: "test-thread", turnId: "earlier-turn", isBlocking: false, questions: [{id: "answer", question: "Your constraints?", options: null}]}};
    const requests = new Map([["42", request]]);
    const respond = vi.fn();
    Object.assign(adapter, {connected: true, rpc: {respond, stop: async () => {}}, requests});
    vi.spyOn(adapter, "follow").mockResolvedValue(true);
    adapter.watched.set("test-thread", normalizeThread({id: "test-thread", threadRuntimeStatus: {type: "idle"}, turns: [], requests: [request]}, 0));
    const payload = {type: "input.respond" as const, threadId: "test-thread", turnId: "earlier-turn", requestId: "42", answers: {answer: {answers: ["Custom constraints"]}}};
    try {
      await expect(adapter.execute(command({...payload, turnId: "foreign-turn"}))).rejects.toMatchObject({code: "stale-request"});
      await expect(adapter.execute(command({...payload, answers: {other: {answers: ["A"]}}}))).rejects.toMatchObject({code: "invalid-answer-set"});
      await expect(adapter.execute(command(payload))).resolves.toMatchObject({acknowledgedByAppServer: true});
      expect(respond).toHaveBeenCalledExactlyOnceWith(42, {answers: {answer: {answers: ["Custom constraints"]}}});
      await expect(adapter.execute(command(payload))).rejects.toMatchObject({code: "stale-request"});
    } finally { await adapter.stop(); }
  });
  it("uses the latest persisted turn context and rejects a broader resumed sandbox", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-remote-settings-"));
    directories.push(home);
    const sessions = join(home, "sessions", "2026", "09", "29");
    await mkdir(sessions, { recursive: true });
    const path = join(sessions, "rollout-test-thread.jsonl");
    const context = (sandbox: string) => JSON.stringify({ type: "turn_context", payload: { approval_policy: "on-request", approvals_reviewer: "user", sandbox_policy: { type: sandbox }, cwd: home, workspace_roots: [home], model: "gpt-test", effort: "low" } });
    await writeFile(path, sessionMeta("test-thread") + `${context("danger-full-access")}\n${context("read-only")}\n`);
    const settings = await savedSettings({ id: "test-thread", path, modelProvider: "test-provider" }, home);
    expect(settings).toMatchObject({ sandbox: "read-only", approvalPolicy: "on-request", modelProvider: "test-provider" });
    const resumed = { sandbox: { type: "readOnly", networkAccess: false }, approvalPolicy: "on-request", approvalsReviewer: "user", model: "gpt-test", modelProvider: "test-provider", cwd: home, runtimeWorkspaceRoots: [home] };
    expect(matchesSettings(resumed, settings)).toBe(true);
    expect(matchesSettings({ ...resumed, sandbox: { type: "dangerFullAccess" } }, settings)).toBe(false);
    expect(matchesSettings({ ...resumed, approvalPolicy: "never" }, settings)).toBe(false);
  });

  it("fails closed when session history has no turn context", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-remote-settings-"));
    directories.push(home);
    const sessions = join(home, "sessions");
    await mkdir(sessions, { recursive: true });
    const path = join(sessions, "rollout-empty.jsonl");
    await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id: "empty" } })}\n`);
    await expect(savedSettings({ id: "empty", path, modelProvider: "test-provider" }, home)).rejects.toMatchObject({ code: "headless-settings-unavailable" });
  });

  it("accepts namespaced paths and forked rollout names only for the matching session", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-remote-fork-settings-")); directories.push(home);
    const sessions = join(home, "sessions"); await mkdir(sessions, { recursive: true });
    const path = join(sessions, "rollout-original-thread_fork-id.jsonl");
    const context = JSON.stringify({ type: "turn_context", payload: { model: "gpt-test", effort: "low", approval_policy: "never", approvals_reviewer: "user", sandbox_policy: { type: "read-only" }, cwd: home, workspace_roots: [home] } });
    await writeFile(path, sessionMeta("original-thread") + context + "\n");
    await expect(savedSettings({ id: "original-thread", path: toNamespacedPath(path), modelProvider: "test-provider" }, home)).resolves.toMatchObject({ sandbox: "read-only", cwd: home });
    await expect(savedSettings({ id: "fork-id", path, modelProvider: "test-provider" }, home)).rejects.toMatchObject({ code: "headless-session-path-invalid" });
  });

  it("rejects files and directory links outside the sessions root", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-remote-settings-boundary-")); directories.push(home);
    const sessions = join(home, "sessions"); await mkdir(sessions, { recursive: true });
    const outside = join(home, "elsewhere"); await mkdir(outside);
    const path = join(outside, "rollout-test-thread.jsonl");
    await writeFile(path, sessionMeta("test-thread"));
    const metadata = { id: "test-thread", path, modelProvider: "test-provider" };
    await expect(savedSettings(metadata, home)).rejects.toMatchObject({ code: "headless-session-path-invalid" });
    await symlink(outside, join(sessions, "external"), process.platform === "win32" ? "junction" : "dir");
    await expect(savedSettings({ ...metadata, path: join(sessions, "external", "rollout-test-thread.jsonl") }, home)).rejects.toMatchObject({ code: "headless-session-path-invalid" });
  });
  it("keeps model changes for the next headless turn while preserving the original permissions and collaboration mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-remote-model-")); directories.push(home);
    const sessions = join(home, "sessions"); await mkdir(sessions, { recursive: true });
    const path = join(sessions, "rollout-test-thread.jsonl");
    await writeFile(path, sessionMeta("test-thread") + JSON.stringify({ type: "turn_context", payload: { model: "old", effort: "high", approval_policy: "on-request", approvals_reviewer: "user", sandbox_policy: { type: "read-only" }, cwd: home, workspace_roots: [home], collaboration_mode: { mode: "plan", settings: { model: "old", reasoning_effort: "high", developer_instructions: "original" } } } }) + "\n");
    const adapter = new HeadlessAdapter();
    const metadata = { id: "test-thread", path, model: "old", modelProvider: "provider", reasoningEffort: "high" };
    adapter.watched.set("test-thread", normalizeThread({ ...metadata, threadRuntimeStatus: { type: "idle" }, turns: [] }, 0));
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const rpc = { stop: async () => {}, request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: metadata };
      if (method === "thread/resume") return { ...params, sandbox: { type: "readOnly" }, runtimeWorkspaceRoots: [home] };
      if (method === "turn/start") return { turn: { id: "new-turn" } };
      return {};
    } };
    Object.assign(adapter, { connected: true, rpc });
    vi.spyOn(adapter, "follow").mockResolvedValue(true);
    vi.stubEnv("CODEX_HOME", home);
    try {
      await adapter.execute(command({ type: "thread.model.update", threadId: "test-thread", expectedModel: "old", model: "new" }));
      expect(calls.find(value => value.method === "thread/settings/update")?.params).toEqual({ threadId: "test-thread", model: "new", collaborationMode: { mode: "plan", settings: { model: "new", reasoning_effort: "high", developer_instructions: "original" } } });
      adapter.models = [{ model: "new", displayName: "New", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" }];
      adapter.watched.set("test-thread", normalizeThread({ ...metadata, model: "new", reasoningEffort: "high", threadRuntimeStatus: { type: "idle" }, turns: [] }, 1));
      await adapter.execute(command({ type: "thread.effort.update", threadId: "test-thread", expectedModel: "new", expectedEffort: "high", effort: "low" }));
      expect(calls.filter(value => value.method === "thread/settings/update")[1]?.params).toEqual({ threadId: "test-thread", effort: "low", collaborationMode: { mode: "plan", settings: { model: "new", reasoning_effort: "low", developer_instructions: "original" } } });
      const turn = command({ type: "turn.start", threadId: "test-thread", text: "Test", images: ["a".repeat(64)] });
      await expect(adapter.execute(turn)).rejects.toMatchObject({ code: "images-not-ready" });
      await adapter.execute(turn, [{ type: "localImage", path: join(home, "image.png") }]);
      const resumes = calls.filter(value => value.method === "thread/resume");
      expect(resumes[1]?.params).toMatchObject({ model: "new", modelProvider: "provider", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only", cwd: home, runtimeWorkspaceRoots: [home] });
      expect(record(calls.find(value => value.method === "turn/start")?.params.collaborationMode)).toMatchObject({ mode: "plan", settings: { model: "new", reasoning_effort: "low", developer_instructions: "original" } });
      expect(calls.find(value => value.method === "turn/start")?.params.input).toEqual([{ type: "text", text: "Test", text_elements: [] }, { type: "localImage", path: join(home, "image.png") }]);
    } finally { await adapter.stop(); vi.unstubAllEnvs(); }
  });
});
