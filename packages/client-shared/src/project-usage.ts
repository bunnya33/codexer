import { tokenBreakdownSchema } from '../../protocol/src/index.js';
import type { HistoryTurn, ProjectUsage, ThreadUsage, TokenBreakdown, TurnTokenUsage } from '../../protocol/src/index.js';
import { defaultModelPricing } from '../../shared/src/model-pricing.js';
import type { ModelPricing, ModelRate } from '../../shared/src/model-pricing.js';

const indexes = new WeakMap<ModelPricing, Map<string, ModelRate>>();

export function estimateTokenCost(group: TokenBreakdown & { model?: string | null }, pricing = defaultModelPricing): number | null {
  if (!group.model) return null;
  let rates = indexes.get(pricing);
  if (!rates) {
    rates = new Map(pricing.models.map(model => [model.id, model]));
    indexes.set(pricing, rates);
  }
  const rate = rates.get(group.model) ?? rates.get(group.model.replace(/-\d{4}-\d{2}-\d{2}$/, ''));
  // Cache-write retention and per-request context/speed aren't in old
  // records. Show a Standard equivalent; never count reasoning twice.
  if (!rate || (group.cacheWriteInputTokens ?? 0) > 0 ||
      rate.cachedInput === null && group.cachedInputTokens > 0) return null;
  return ((group.inputTokens - group.cachedInputTokens) * rate.input
    + group.cachedInputTokens * (rate.cachedInput ?? 0) + group.outputTokens * rate.output) / 1_000_000;
}

export function estimateProjectCost(usage: Pick<ProjectUsage, 'models' | 'totalTokens' | 'partial'>, pricing?: ModelPricing) {
  let usd = 0, pricedTokens = 0;
  for (const group of usage.models) {
    const cost = estimateTokenCost(group, pricing);
    if (cost === null) continue;
    usd += cost;
    pricedTokens += group.totalTokens;
  }
  return { usd, pricedTokens, partial: usage.partial || pricedTokens < usage.totalTokens,
    unpricedTokens: Math.max(0, usage.totalTokens - pricedTokens) };
}

export function compactTokens(value: number): string {
  const [unit, scale] = value >= 1e9 ? ['B', 1e9] : value >= 1e6 ? ['M', 1e6] : value >= 1e4 ? ['K', 1e3] : ['', 1];
  return unit ? `${(value / Number(scale)).toFixed(2).replace(/\.?0+$/, '')}${unit}` : value.toLocaleString();
}
export function usdLabel(value: number, decimals = 2): string {
  const minimum = 10 ** -decimals;
  return value > 0 && value < minimum ? `<$${minimum.toFixed(decimals)}` : `$${value.toFixed(decimals)}`;
}

export function turnCostLabel(usage?: TurnTokenUsage, pricing?: ModelPricing): string {
  if (!usage) return '';
  const cost = estimateTokenCost(usage, pricing);
  return cost === null ? '' : usdLabel(cost, 4);
}

export function projectUsageLabel(usage?: ProjectUsage, pricing?: ModelPricing): string {
  if (!usage) return '项目 Token 待同步';
  if (usage.totalThreads > 0 && !usage.knownThreads && !usage.recordedTokens) return '项目 Token 待同步';
  const cost = estimateProjectCost(usage, pricing);
  const tokens = `项目累计 ${usage.knownThreads < usage.totalThreads ? '≥' : ''}${compactTokens(usage.totalTokens)} Token`;
  if (usage.totalTokens > 0 && cost.pricedTokens === 0) return `${tokens} · 费用待统计`;
  return `${tokens} · ${cost.partial ? '部分预估' : '预估'} ${usdLabel(cost.usd)}`;
}

export function threadUsageLabel(usage?: ThreadUsage, pricing?: ModelPricing): string {
  if (!usage || !usage.totalKnown && !usage.recordedTokens) return '会话 Token 待同步';
  const cost = estimateProjectCost(usage, pricing);
  const tokens = `会话累计 ${usage.totalKnown ? '' : '≥'}${compactTokens(usage.totalTokens)} Token`;
  if (usage.totalTokens > 0 && !cost.pricedTokens) return `${tokens} · 费用待统计`;
  return `${tokens} · ${cost.partial ? '部分预估' : '预估'} ${usdLabel(cost.usd, 4)}`;
}

// Older Agents still provide this chat's cumulative counters and loaded turns.
// Keep those separate from project totals and mark unavailable history as partial.
export function currentThreadUsage(summary: ThreadUsage | undefined, tokenUsage: Record<string, unknown> | null | undefined, turns: HistoryTurn[]): ThreadUsage | undefined {
  if (summary) return summary;
  const total = tokenBreakdownSchema.safeParse(tokenUsage?.total);
  const models = new Map<string | null, ThreadUsage['models'][number]>();
  let recordedTokens = 0;
  for (const turn of new Map(turns.map(turn => [turn.id, turn])).values()) {
    const value = turn.tokenUsage;
    if (!value) continue;
    recordedTokens += value.totalTokens;
    const model = value.model ?? null;
    const group = models.get(model) ?? { model, totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    for (const key of ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens'] as const) group[key] = (group[key] ?? 0) + (value[key] ?? 0);
    models.set(model, group);
  }
  if (!total.success && !recordedTokens) return undefined;
  return { totalTokens: Math.max(total.success ? total.data.totalTokens : 0, recordedTokens), recordedTokens, totalKnown: total.success, partial: true, models: [...models.values()] };
}
