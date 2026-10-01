import { expect, it } from "vitest";
import { normalizeOfficialCatalog } from "../packages/codex-adapter/src/headless.js";
import { normalizeHistoryTurn } from "../packages/codex-adapter/src/normalize.js";
import { catalogSchema } from "../packages/protocol/src/index.js";

it("keeps all projects including empty ones and assigns older Windows threads by the closest root", () => {
  const projects = [
    { id: "parent", name: "Parent", roots: [{ path: "F:\\Work" }], position: 0 },
    { id: "child", name: "Child", roots: [{ path: "F:\\Work\\Project" }], position: 1 },
    { id: "empty", name: "Empty", roots: [{ path: "F:\\Empty" }], position: 2 },
  ];
  const threads = Array.from({ length: 30 }, (_, index) => ({ id: `thread-${index}`, name: `Saved title ${index}`, cwd: "f:/work/project/src", updatedAt: index }));
  const result = normalizeOfficialCatalog("device", projects, [...threads, { id: "explicit", cwd: "F:\\Work\\Project", projectId: "parent", archived: true }, { id: "unassigned", cwd: "F:\\Workspace" }]);
  expect(catalogSchema.parse(result).projects).toHaveLength(3);
  expect(result.threads).toHaveLength(32);
  expect(result.threads[0]).toMatchObject({ projectId: "child", title: "Saved title 0" });
  expect(result.threads.at(-2)).toMatchObject({ projectId: "parent", archived: true });
  expect(result.threads.at(-1)?.projectId).toBeNull();
});

it("keeps older full-history messages larger than the recent preview and marks bounded truncation", () => {
  const turn = normalizeHistoryTurn({ id: "old-turn", status: "completed", items: [{ id: "message", type: "agentMessage", text: "x".repeat(6000) }, { id: "long-message", type: "agentMessage", text: "x".repeat(33000) }] });
  expect(turn.items[0]?.text).toHaveLength(6000);
  expect(turn.items[0]?.truncated).toBe(false);
  expect(turn.items[1]?.text).toHaveLength(32000);
  expect(turn.items[1]?.truncated).toBe(true);
});

it("deduplicates official thread listings by ID and keeps the newest metadata", () => {
  const result = normalizeOfficialCatalog("device", [], [
    { id: "duplicate", name: "Old title", updatedAt: 1 },
    { id: "duplicate", name: "Latest title", updatedAt: 3, archived: true },
    { id: "other", name: "Other", updatedAt: 2 },
    { id: "duplicate", name: "Older copy", updatedAt: 2 },
  ]);
  expect(result.threads).toHaveLength(2);
  expect(result.threads.find(thread => thread.id === "duplicate")).toMatchObject({ title: "Latest title", updatedAt: 3000, archived: true });
  expect(catalogSchema.safeParse({ ...result, threads: result.threads.concat(result.threads[0]!) }).success).toBe(false);
});
