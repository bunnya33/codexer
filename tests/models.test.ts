import { describe, expect, it } from "vitest";
import { modelOverride, normalizeModels } from "../packages/codex-adapter/src/models.js";
import { normalizeThread } from "../packages/codex-adapter/src/normalize.js";
import { commandSchema, turnTokenUsageSchema } from "../packages/protocol/src/index.js";
import { command, rawThread } from "./helpers.js";

describe("model options and protocol", () => {
  it("takes current official settings before the last persisted turn model", () => {
    const thread = normalizeThread({ ...rawThread(), latestModel: "old-model", latestThreadSettings: { model: "new-model", modelProvider: "provider", effort: "high" } }, 1);
    expect(thread.settings).toEqual({ model: "new-model", modelProvider: "provider", reasoningEffort: "high", collaborationMode: null });
  });
  it("filters hidden and malformed models and changes only an unsupported effort", () => {
    const model = { model: "new", displayName: "New", supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" };
    const models = normalizeModels([model, { ...model, model: "hidden", hidden: true }, { model: "invalid" }]);
    expect(models).toHaveLength(1);
    expect(modelOverride("new", "high", models)).toEqual({ model: "new" });
    expect(modelOverride("new", "ultra", models)).toEqual({ model: "new", effort: "high" });
    expect(modelOverride("custom", "high", models)).toEqual({ model: "custom" });
  });
  it("bounds model commands and rejects contradictory usage numbers", () => {
    const value = command({ type: "thread.model.update", threadId: "thread-test", model: "model-a", expectedModel: "model-b" });
    expect(commandSchema.safeParse(value).success).toBe(true);
    expect(commandSchema.safeParse({ ...value, payload: { ...value.payload, model: "bad model" } }).success).toBe(false);
    expect(turnTokenUsageSchema.safeParse({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 101, totalTokens: 110, state: "complete" }).success).toBe(false);
  });
});
