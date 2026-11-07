import { expect, it } from 'vitest';
import { projectUsageSchema, type ProjectUsage } from '../packages/protocol/src/index';
import { compactTokens, estimateProjectCost, projectUsageLabel, turnCostLabel, usdLabel } from '../packages/client-shared/src/project-usage';

function usage(): ProjectUsage {
  return { totalTokens: 1_200_000, recordedTokens: 1_200_000, totalThreads: 3, knownThreads: 3, partial: false,
    models: [{ model: 'gpt-5.3-codex', inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 200_000, reasoningOutputTokens: 150_000, totalTokens: 1_200_000 }] };
}
it('prices cache hits separately and counts reasoning in output exactly once', () => {
  const estimate = estimateProjectCost(usage());
  expect(estimate.usd).toBeCloseTo(3.29);
  expect(estimate).toMatchObject({ pricedTokens: 1_200_000, unpricedTokens: 0, partial: false });
  expect(projectUsageLabel(usage())).toBe('项目累计 1.2M Token · 预估 $3.29');
});
it('keeps archived/historical totals when only part has priced model records', () => {
  const value = { ...usage(), totalTokens: 9_000_000 };
  expect(estimateProjectCost(value)).toMatchObject({ partial: true, unpricedTokens: 7_800_000 });
  expect(projectUsageLabel(value)).toBe('项目累计 9M Token · 部分预估 $3.29');
});
it('does not guess unknown model or cache-write prices or report unavailable data as zero', () => {
  for (const model of ['unknown', null]) {
    const value = usage(); value.models[0]!.model = model;
    expect(estimateProjectCost(value)).toMatchObject({ pricedTokens: 0, partial: true });
    expect(projectUsageLabel(value)).toContain('费用待统计');
  }
  const value = usage(); value.models[0]!.cacheWriteInputTokens = 100;
  expect(estimateProjectCost(value).pricedTokens).toBe(0);
  expect(projectUsageLabel(undefined)).toBe('项目 Token 待同步');
  expect(projectUsageLabel({ ...value, totalTokens: 0, recordedTokens: 0, knownThreads: 0 })).toBe('项目 Token 待同步');
});
it('sums mixed models and marks missing thread totals as a lower bound', () => {
  const value = usage(); value.models.push({ ...value.models[0]!, model: 'gpt-5.4-2026-03-05' });
  value.totalTokens *= 2; value.recordedTokens *= 2; value.knownThreads = 2; value.partial = true;
  expect(estimateProjectCost(value).usd).toBeCloseTo(6.99);
  expect(projectUsageLabel(value)).toContain('项目累计 ≥2.4M Token · 部分预估');
});
it('preserves small costs and rejects corrupt coverage or counters', () => {
  expect(usdLabel(0.0001)).toBe('<$0.01');
  expect(compactTokens(10_000)).toBe('10K');
  expect(compactTokens(1_000_000_000)).toBe('1B');
  expect(projectUsageSchema.safeParse({ ...usage(), knownThreads: 4 }).success).toBe(false);
  expect(projectUsageSchema.safeParse({ ...usage(), totalTokens: -1 }).success).toBe(false);
});

it('prices each reply from its own recorded model and counters with four-decimal precision', () => {
  const value = { model: 'gpt-5.3-codex', totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200, reasoningOutputTokens: 150, state: 'complete' as const };
  expect(turnCostLabel(value)).toBe('本次预估 $0.0038');
  expect(turnCostLabel({ ...value, state: 'partial' })).toBe('本次部分预估 $0.0038');
  expect(turnCostLabel({ ...value, state: 'running' })).toBe('本次部分预估 $0.0038');
  expect(turnCostLabel({ ...value, model: 'gpt-5.4-2026-03-05' })).toBe('本次预估 $0.0044');
  expect(turnCostLabel({ ...value, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1 })).toBe('本次预估 <$0.0001');
});

it('does not invent reply fees from a missing model, usage, or unsupported cache writes', () => {
  const value = { ...usage().models[0]!, model: 'gpt-5.3-codex', state: 'complete' as const };
  expect(turnCostLabel()).toBe('本次费用待统计');
  for (const model of [undefined, 'unknown', '__proto__', 'constructor']) expect(turnCostLabel({ ...value, model })).toBe('本次费用暂不可估');
  expect(turnCostLabel({ ...value, cacheWriteInputTokens: 1 })).toBe('本次费用暂不可估');
});
