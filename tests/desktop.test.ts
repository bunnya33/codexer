import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopAdapter } from "../packages/codex-adapter/src/desktop.js";
import { record } from "../packages/codex-adapter/src/normalize.js";
import { command, FakeDesktop, rawThread, waitFor } from "./helpers.js";

describe("official desktop compatibility boundary", () => {
  let desktop: FakeDesktop, adapter: DesktopAdapter;
  beforeEach(async () => {
    desktop = new FakeDesktop(); await desktop.start();
    adapter = new DesktopAdapter(desktop.endpoint); await adapter.connect();
    expect(await adapter.follow("thread-test")).toBe(true);
    await waitFor(() => adapter.getThread("thread-test") !== null);
  });
  afterEach(async () => { adapter.stop(); await desktop.close(); });

  it("starts an idle turn through the existing owner without overriding auth or permissions", async () => {
    desktop.state = rawThread("idle"); desktop.publishSnapshot();
    await waitFor(() => adapter.getThread("thread-test")?.status === "idle");
    const input = command({ type: "turn.start", threadId: "thread-test", text: "Test" });
    await expect(adapter.execute(input)).resolves.toMatchObject({ turnId: "turn-new", acknowledgedByDesktop: true });
    const request = desktop.received.find(value => value.method === "thread-follower-start-turn")!;
    expect(request.targetClientId).toBe(desktop.ownerId);
    expect(request.version).toBe(2);
    expect(record(record(request.params).turnStart).request).toEqual({ threadId: "thread-test", input: [{ type: "text", text: "Test", text_elements: [] }], clientUserMessageId: input.commandId });
    expect(record(record(request.params).turnStart).context).toMatchObject({ attachments: [], commentAttachments: [], inheritThreadSettings: true });
  });
  it("rejects a start observed during an active turn", async () => {
    await expect(adapter.execute(command({ type: "turn.start", threadId: "thread-test", text: "Test" }))).rejects.toMatchObject({ code: "thread-not-idle" });
    expect(desktop.received.some(value => value.method === "thread-follower-start-turn")).toBe(false);
  });
  it("updates only the model through the official owner with a settings condition", async () => {
    desktop.state = { ...rawThread("idle"), latestModel: "model-a", latestReasoningEffort: "high", latestThreadSettings: { model: "model-a", modelProvider: "private-provider", effort: "high", approvalPolicy: "on-request" } };
    desktop.response = () => ({ applied: true });
    desktop.publishSnapshot();
    await waitFor(() => adapter.getThread("thread-test")?.settings?.model === "model-a");
    await expect(adapter.execute(command({ type: "thread.model.update", threadId: "thread-test", expectedModel: "model-a", model: "model-b" }))).resolves.toEqual({ model: "model-b", acknowledgedByDesktop: true });
    const request = desktop.received.find(value => value.method === "thread-follower-update-thread-settings")!;
    expect(request.version).toBe(2);
    expect(request.targetClientId).toBe(desktop.ownerId);
    expect(request.params).toEqual({ conversationId: "thread-test", threadSettings: { model: "model-b" }, condition: { ifModelEquals: "model-a", ifEffortEquals: "high" } });
    desktop.response = () => ({ applied: false });
    await expect(adapter.execute(command({ type: "thread.model.update", threadId: "thread-test", expectedModel: "model-a", model: "model-b" }))).rejects.toMatchObject({ code: "stale-model" });
  });
  it("rejects model changes on active threads and stale current models", async () => {
    const payload = { type: "thread.model.update" as const, threadId: "thread-test", expectedModel: "old", model: "new" };
    await expect(adapter.execute(command(payload))).rejects.toMatchObject({ code: "thread-not-idle" });
    desktop.state = { ...rawThread("idle"), latestModel: "other" }; desktop.publishSnapshot();
    await waitFor(() => adapter.getThread("thread-test")?.status === "idle");
    await expect(adapter.execute(command(payload))).rejects.toMatchObject({ code: "stale-model" });
    expect(desktop.received.some(value => value.method === "thread-follower-update-thread-settings")).toBe(false);
  });
  it("updates reasoning effort only and rejects unsupported or stale settings", async () => {
    desktop.state = { ...rawThread("idle"), latestModel: "model-a", latestReasoningEffort: "low" };
    desktop.response = () => ({ applied: true });
    adapter.models = [{ model: "model-a", displayName: "A", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" }];
    desktop.publishSnapshot(); await waitFor(() => adapter.getThread("thread-test")?.settings?.model === "model-a");
    const payload = { type: "thread.effort.update" as const, threadId: "thread-test", expectedModel: "model-a", expectedEffort: "low", effort: "high" as const };
    await expect(adapter.execute(command(payload))).resolves.toEqual({ effort: "high", acknowledgedByDesktop: true });
    expect(desktop.received.find(value => value.method === "thread-follower-update-thread-settings")?.params).toEqual({ conversationId: "thread-test", threadSettings: { effort: "high" }, condition: { ifModelEquals: "model-a", ifEffortEquals: "low" } });
    await expect(adapter.execute(command({ ...payload, effort: "ultra" }))).rejects.toMatchObject({ code: "unsupported-effort" });
    await expect(adapter.execute(command({ ...payload, expectedEffort: "medium" }))).rejects.toMatchObject({ code: "stale-effort" });
  });
  it("passes resolved local images to the official owner and refuses unresolved IDs", async () => {
    desktop.state = rawThread("idle"); desktop.publishSnapshot(); await waitFor(() => adapter.getThread("thread-test")?.status === "idle");
    const input = command({ type: "turn.start", threadId: "thread-test", text: "", images: ["a".repeat(64)] });
    await expect(adapter.execute(input)).rejects.toMatchObject({ code: "images-not-ready" });
    await adapter.execute(input, [{ type: "localImage", path: "/agent/images/test.png" }]);
    const request = record(record(desktop.received.find(value => value.method === "thread-follower-start-turn")?.params).turnStart).request;
    expect(request).toMatchObject({ input: [{ type: "localImage", path: "/agent/images/test.png" }] });
  });
  it("never sends a stale Stop and includes expectedTurnId in a valid Stop", async () => {
    await expect(adapter.execute(command({ type: "turn.interrupt", threadId: "thread-test", turnId: "old-turn" }))).rejects.toMatchObject({ code: "stale-turn" });
    expect(desktop.received.some(value => value.method === "thread-follower-interrupt-turn")).toBe(false);
    await expect(adapter.execute(command({ type: "turn.interrupt", threadId: "thread-test", turnId: "turn-A" }))).resolves.toMatchObject({ interruptedTurnId: "turn-A" });
    const request = desktop.received.find(value => value.method === "thread-follower-interrupt-turn")!;
    expect(request.version).toBe(4);
    expect(request.params).toEqual({ conversationId: "thread-test", mode: "user-stop", expectedTurnId: "turn-A" });
  });
  it("treats a turn changing between observation and Stop delivery as stale", async () => {
    desktop.response = () => ({ ok: true, interruptedTurnId: null });
    await expect(adapter.execute(command({ type: "turn.interrupt", threadId: "thread-test", turnId: "turn-A" }))).rejects.toMatchObject({ code: "stale-turn" });
  });
  it("answers numeric approval request IDs and rejects locally resolved approvals", async () => {
    desktop.state.requests = [{ id: 42, method: "item/commandExecution/requestApproval", params: { turnId: "turn-A", command: "npm test", availableDecisions: ["accept", "decline"] } }];
    desktop.publishSnapshot(); await waitFor(() => adapter.getThread("thread-test")?.requests.length === 1);
    const input = command({ type: "approval.respond", threadId: "thread-test", turnId: "turn-A", requestId: "42", decision: "accept" });
    await expect(adapter.execute(input)).resolves.toMatchObject({ acknowledgedByDesktop: true });
    expect(record(desktop.received.find(value => value.method === "thread-follower-command-approval-decision")?.params).requestId).toBe(42);
    desktop.state.requests = []; desktop.publishSnapshot(); await waitFor(() => adapter.getThread("thread-test")?.requests.length === 0);
    await expect(adapter.execute(input)).rejects.toMatchObject({ code: "stale-request" });
  });
  it("requires exactly the current user-input question IDs", async () => {
    desktop.state.requests = [{ id: "question", method: "item/tool/requestUserInput", params: { turnId: "turn-A", questions: [{ id: "choice" }] } }];
    desktop.publishSnapshot(); await waitFor(() => adapter.getThread("thread-test")?.requests.length === 1);
    await expect(adapter.execute(command({ type: "input.respond", threadId: "thread-test", turnId: "turn-A", requestId: "question", answers: { other: { answers: ["a"] } } }))).rejects.toMatchObject({ code: "invalid-answer-set" });
    await expect(adapter.execute(command({ type: "input.respond", threadId: "thread-test", turnId: "turn-A", requestId: "question", answers: { choice: { answers: ["a"] } } }))).resolves.toMatchObject({ acknowledgedByDesktop: true });
  });
  it("rejects approval decisions that the owner did not offer", async () => {
    desktop.state.requests = [{ id: 43, method: "item/commandExecution/requestApproval", params: { turnId: "turn-A", availableDecisions: ["decline", "cancel"] } }];
    desktop.publishSnapshot(); await waitFor(() => adapter.getThread("thread-test")?.requests.length === 1);
    await expect(adapter.execute(command({ type: "approval.respond", threadId: "thread-test", turnId: "turn-A", requestId: "43", decision: "accept" }))).rejects.toMatchObject({ code: "decision-not-available" });
    expect(desktop.received.some(value => value.method === "thread-follower-command-approval-decision")).toBe(false);
  });
  it("applies ordered Immer patches and refetches a snapshot after a gap", async () => {
    desktop.publishPatches([{ op: "replace", path: ["title"], value: "Updated" }]);
    await waitFor(() => adapter.getThread("thread-test")?.title === "Updated");
    desktop.autoSnapshot = false;
    desktop.publishPatches([{ op: "replace", path: ["title"], value: "Skipped" }], 99);
    await waitFor(() => adapter.getThread("thread-test")?.status === "unavailable");
    await expect(adapter.execute(command({ type: "turn.interrupt", threadId: "thread-test", turnId: "turn-A" }))).rejects.toMatchObject({ code: "desktop-owner-unavailable" });
    desktop.state.title = "Recovered"; desktop.publishSnapshot();
    await waitFor(() => adapter.getThread("thread-test")?.title === "Recovered");
    expect(adapter.getThread("thread-test")?.ownerAvailable).toBe(true);
  });
  it("disables controls and publishes unavailable state for an unknown IPC version", async () => {
    desktop.publishSnapshot(12);
    await waitFor(() => adapter.getThread("thread-test")?.status === "unavailable");
    await expect(adapter.execute(command({ type: "turn.interrupt", threadId: "thread-test", turnId: "turn-A" }))).rejects.toMatchObject({ code: "desktop-owner-unavailable" });
  });
  it("does not report success for malformed desktop control responses", async () => {
    desktop.response = () => ({ interruptedTurnId: "turn-A" });
    await expect(adapter.execute(command({ type: "turn.interrupt", threadId: "thread-test", turnId: "turn-A" }))).rejects.toMatchObject({ code: "incompatible-desktop-response", uncertain: true });
  });
  it("confirms read-only history and an ignored Stop using a nonexistent turn ID", async () => {
    await expect(adapter.checkControl("thread-test")).resolves.toEqual({ historyRevision: 0, staleInterruptIgnored: true });
  });
});
