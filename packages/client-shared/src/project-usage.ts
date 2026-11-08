import { tokenBreakdownSchema } from '../../protocol/src/index.js';
import type { HistoryTurn, ProjectUsage, ThreadUsage, TokenBreakdown, TurnTokenUsage } from '../../protocol/src/index.js';

export const pricingSource = 'https://developers.openai.com/api/docs/pricing';
export const pricingDate = '2026-11-08';
// USD per million tokens, Standard speed, short context. Exact model IDs only;
// unknown models never inherit a similar model's rate.
const prices: Record<string, readonly [number, number | null, number]> = {
  'gpt-6-astra': [10, 1, 50], 'gpt-6.1-sol': [2, 0.1, 10],
  'gpt-6.1-terra': [1, 0.05, 5], 'gpt-6-sol': [2, 0.2, 10], 'gpt-6-luna': [0.1, 0.01, 0.5],
  'gpt-5.6-sol': [4, 0.4, 20], 'gpt-5.6-terra': [2, 0.2, 12], 'gpt-5.6-luna': [0.2, 0.02, 1.2],
  'gpt-5.5': [5, 0.5, 30], 'gpt-5.5-pro': [30, null, 180],
  'gpt-5.4': [2.5, 0.25, 15], 'gpt-5.4-pro': [30, null, 180],
  'gpt-5.4-mini': [0.75, 0.075, 4.5], 'gpt-5.4-nano': [0.2, 0.02, 1.25],
  'gpt-5.3-codex': [1.75, 0.175, 14], 'gpt-5.2': [1.75, 0.175, 14], 'gpt-5.2-pro': [21, null, 168],
  'gpt-5.1': [1.25, 0.125, 10], 'gpt-5': [1.25, 0.125, 10],
  'gpt-5-mini': [0.25, 0.025, 2], 'gpt-5-nano': [0.05, 0.005, 0.4], 'gpt-5-pro': [15, null, 120],
  'gpt-4.1': [2, 0.5, 8], 'gpt-4.1-mini': [0.4, 0.1, 1.6],
  'gpt-4o': [2.5, 1.25, 10], 'gpt-4o-mini': [0.15, 0.075, 0.6], 'o3': [2, 0.5, 8], 'o3-pro': [20, null, 80],
};

export function estimateTokenCost(group: TokenBreakdown & { model?: string | null }): number | null {
  const model = group.model?.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const rate = model && Object.prototype.hasOwnProperty.call(prices, model) ? prices[model] : undefined;
  // Cache-write retention and per-request context/speed aren't in old
  // records. Show a Standard equivalent; never count reasoning twice.
  if (!rate || (group.cacheWriteInputTokens ?? 0) > 0 ||
      rate[1] === null && group.cachedInputTokens > 0) return null;
  return ((group.inputTokens - group.cachedInputTokens) * rate[0]
    + group.cachedInputTokens * (rate[1] ?? 0) + group.outputTokens * rate[2]) / 1_000_000;
}

export function estimateProjectCost(usage: Pick<ProjectUsage, 'models' | 'totalTokens' | 'partial'>) {
  let usd = 0, pricedTokens = 0;
  for (const group of usage.models) {
    const cost = estimateTokenCost(group);
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

export function turnCostLabel(usage?: TurnTokenUsage): string {
  if (!usage) return '';
  const cost = estimateTokenCost(usage);
  return cost === null ? '' : usdLabel(cost, 4);
}

export function projectUsageLabel(usage?: ProjectUsage): string {
  if (!usage) return '项目 Token 待同步';
  if (usage.totalThreads > 0 && !usage.knownThreads && !usage.recordedTokens) return '项目 Token 待同步';
  const cost = estimateProjectCost(usage);
  const tokens = `项目累计 ${usage.knownThreads < usage.totalThreads ? '≥' : ''}${compactTokens(usage.totalTokens)} Token`;
  if (usage.totalTokens > 0 && cost.pricedTokens === 0) return `${tokens} · 费用待统计`;
  return `${tokens} · ${cost.partial ? '部分预估' : '预估'} ${usdLabel(cost.usd)}`;
}

export function threadUsageLabel(usage?: ThreadUsage): string {
  if (!usage || !usage.totalKnown && !usage.recordedTokens) return '会话 Token 待同步';
  const cost = estimateProjectCost(usage);
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
