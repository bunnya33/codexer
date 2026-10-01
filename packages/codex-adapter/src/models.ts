import { modelOptionSchema } from "../../protocol/src/index.js";
import type { ModelOption } from "../../protocol/src/index.js";
import { record } from "./normalize.js";
import type { RecordValue } from "./normalize.js";

export function normalizeModels(values: unknown[]): ModelOption[] {
  return values.flatMap(value => {
    const model = record(value);
    if (model.hidden === true) return [];
    const parsed = modelOptionSchema.safeParse({ model: model.model, displayName: model.displayName ?? model.model,
      supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map(effort => record(effort).reasoningEffort) : [],
      defaultReasoningEffort: model.defaultReasoningEffort });
    return parsed.success ? [parsed.data] : [];
  }).slice(0, 200);
}

export function modelOverride(model: string, effort: string | null | undefined, models: ModelOption[]): RecordValue {
  const option = models.find(value => value.model === model);
  return { model, ...(option && effort && !option.supportedReasoningEfforts.includes(effort) ? { effort: option.defaultReasoningEffort } : {}) };
}

export function supportsEffort(model: string, effort: string, models: ModelOption[]): boolean {
  return models.some(option => option.model === model && option.supportedReasoningEfforts.includes(effort));
}
