import { expect, it } from 'vitest';
import { subAgentSchema, type RemoteSubAgent, type ThreadUsage } from '../packages/protocol/src/index.js';
import { conversationSubAgents, subAgentUsageLabel, subAgentUsageTotal } from '../packages/client-shared/src/sub-agents.js';
import { estimateProjectCost } from '../packages/client-shared/src/project-usage.js';

const usage = (model = 'gpt-5.3-codex'): ThreadUsage => ({
  totalTokens: 1200, recordedTokens: 1200, totalKnown: true, partial: false,
  models: [{ model, totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200, reasoningOutputTokens: 150 }],
});
const agent = (threadId: string, value?: ThreadUsage): RemoteSubAgent => ({
  threadId, parentThreadId: 'parent', status: 'completed', statusSource: 'activity', ...(value ? { usage: value } : {}),
});

it('totals distinct child sessions including nested/closed agents and prices their actual models', () => {
  const children = [agent('a', usage()), { ...agent('nested', usage('gpt-5.4')), parentThreadId: 'a', status: 'shutdown' as const }];
  const summary = subAgentUsageTotal([...children, children[0]!]);
  expect(summary).toMatchObject({ known: 2, total: 2, usage: { totalTokens: 2400, recordedTokens: 2400, totalKnown: true, partial: false } });
  const cost = estimateProjectCost(summary.usage);
  expect(cost.usd).toBeCloseTo(estimateProjectCost(children[0]!.usage!).usd + estimateProjectCost(children[1]!.usage!).usd);
  expect(subAgentUsageLabel(summary.usage, '子 Agent 合计')).toBe('子 Agent 合计 2,400 Token · $0.0081');
});

it('keeps missing/partial/truncated children visible as pending or a lower bound without invented zero costs', () => {
  const result = subAgentUsageTotal([agent('known', usage()), agent('missing')]);
  expect(result).toMatchObject({ known: 1, total: 2, usage: { totalTokens: 1200, totalKnown: false, partial: true } });
  expect(subAgentUsageLabel(result.usage, '子 Agent 合计')).toContain('≥1,200 Token · 部分预估');
  expect(subAgentUsageLabel(undefined)).toContain('待同步');
  expect(subAgentUsageLabel(subAgentUsageTotal([agent('missing')]).usage)).toContain('待同步');
  expect(subAgentUsageTotal([agent('a', usage())], true).usage).toMatchObject({ totalKnown: false, partial: true });
  expect(subAgentUsageLabel({ ...usage(), models: [], recordedTokens: 0 })).toContain('费用待统计');
});

it('preserves usage across sparse activity updates and accepts it in the shared protocol', () => {
  const value = agent('a', usage());
  const children = conversationSubAgents({ id: 'parent', subAgents: [value] } as never,
    [{ id: 'turn', status: 'completed', truncated: false, items: [{ id: 'spawn', type: 'collabAgentToolCall', truncated: false, subAgents: [agent('a')] }] }]);
  expect(children).toEqual([value]);
  expect(subAgentSchema.parse(value).usage).toEqual(value.usage);
  expect(subAgentSchema.safeParse({ ...value, usage: { ...usage(), totalTokens: -1 } }).success).toBe(false);
  expect(subAgentSchema.safeParse({ ...value, usage: { ...usage(), models: [{ ...usage().models[0]!, cachedInputTokens: 1001 }] } }).success).toBe(false);
});

it('sums available prices even when another child has unsupported cache-write pricing', () => {
  const unpriced = usage(); unpriced.models[0]!.cacheWriteInputTokens = 100;
  const total = subAgentUsageTotal([agent('a', usage()), agent('b', unpriced)]);
  expect(estimateProjectCost(total.usage)).toMatchObject({ pricedTokens: 1200, unpricedTokens: 1200, partial: true });
  expect(estimateProjectCost(total.usage).usd).toBeCloseTo(estimateProjectCost(usage()).usd);
});
