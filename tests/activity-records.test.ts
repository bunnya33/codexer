import {describe, expect, it} from 'vitest';
import {activitySections, collaborationSummary, executionItemActive, imageActivitySummary} from '../packages/client-shared/src/activity.js';
import {normalizeHistoryTurn, normalizeThread} from '../packages/codex-adapter/src/normalize.js';
import {historyTurnSchema, threadSchema} from '../packages/protocol/src/index.js';
import type {RemoteItem, RemoteSubAgent} from '../packages/protocol/src/index.js';

const child: RemoteSubAgent = {threadId: 'child', name: 'Linnaeus', status: 'running', statusSource: 'activity'};
const item = (id: string, type: string, rest: Partial<RemoteItem> = {}): RemoteItem => ({id, type, truncated: false, ...rest});

describe('inline Codex activity records', () => {
  it.each(['started', 'interacted', 'interrupted', 'completed'] as const)('preserves the public %s event through live and history transport', kind => {
    const raw = {id: 'turn', status: 'inProgress', items: [{id:'event', type:'subAgentActivity', kind, agentThreadId:'child', agentPath:'/root/Linnaeus', arguments:{secret:'never forward'}}]};
    const live = threadSchema.parse(normalizeThread({id:'parent', threadRuntimeStatus:{type:'active'}, turns:[raw]}, 1));
    const history = historyTurnSchema.parse(normalizeHistoryTurn(raw, undefined, 'parent'));
    for (const event of [live.turns[0]!.items[0]!, history.items[0]!]) {
      expect(event.agentActivity).toBe(kind);
      expect(JSON.stringify(event)).not.toContain('never forward');
    }
    expect(normalizeHistoryTurn({...raw, items:[{...raw.items[0], kind:'future-kind'}]}).items[0]!.agentActivity).toBeUndefined();
  });

  it('keeps agent actions and image groups in sequence outside collapsed command records', () => {
    const images = (prefix: string, count: number) => Array.from({length:count}, (_, i) => item(`${prefix}${i}`, 'imageView'));
    const sections = activitySections({id:'work', kind:'activity', state:'running', items:[
      item('command', 'commandExecution'), item('send', 'collabAgentToolCall', {tool:'sendInput', status:'completed', subAgents:[child]}),
      item('started', 'subAgentActivity', {agentActivity:'started', subAgents:[child]}),
      ...images('first', 3), item('reply', 'agentMessage', {text:'继续检查', phase:'commentary'}), ...images('second', 4),
      item('wait', 'collabAgentToolCall', {tool:'wait', status:'inProgress', subAgents:[child]}),
      item('placeholder', 'reasoning'),
    ]});
    expect(sections.map(section => section.kind)).toEqual(['execution','collaboration','collaboration','images','message','images','collaboration']);
    expect(sections.filter(section => section.kind === 'images').map(imageActivitySummary)).toEqual(['已查看 3 张图像','已查看 4 张图像']);
    expect(sections[0]).toMatchObject({running:false, items:[{id:'command'}]});
    expect(sections.at(-1)).toMatchObject({item:{id:'wait'}, running:true});
  });

  it('preserves start events even when the live agent has since completed and counts unique targets', () => {
    const started = item('started', 'subAgentActivity', {agentActivity:'started', subAgents:[{...child,name:undefined}]});
    expect(collaborationSummary(started, false, [{...child,status:'completed'}])).toBe('Linnaeus开始工作');
    expect(collaborationSummary({...started, agentActivity:'completed'}, false, [child])).toBe('Linnaeus已完成工作');
    expect(collaborationSummary(item('send', 'collabAgentToolCall', {tool:'sendInput', status:'completed', subAgents:[child, child]}), true)).toBe('已发消息1个智能体');
    const wait = item('wait', 'collabAgentToolCall', {tool:'wait', status:'inProgress', subAgents:[child]});
    expect(collaborationSummary(wait, true)).toBe('等待智能体完成');
    expect(executionItemActive(wait, true)).toBe(true);
    expect(executionItemActive({...wait,status:'completed'}, true)).toBe(false);
    expect(child.status).toBe('running');
    expect(collaborationSummary({...wait,status:'failed'}, false)).toBe('失败：等待智能体完成');
    expect(collaborationSummary({...wait,activityTitle:'Waiting for agent completion'}, true)).toBe('Waiting for agent completion');
  });

  it('counts view events even without previews, preserves repeat views and never merges across an intervening command', () => {
    const image = {id:'a'.repeat(64), name:'view.png'};
    const items = [item('one','imageView',{images:[image]}), item('two','imageView',{images:[image]}), item('old','imageView')];
    expect(imageActivitySummary({kind:'images',id:'images',items})).toBe('已查看 3 张图像');
    expect(imageActivitySummary({kind:'images',id:'images',items:[{...items[0]!,status:'failed'}]})).toContain('查看失败');
    const sections = activitySections({kind:'activity',id:'work',state:'completed',items:[items[0]!,item('command','commandExecution'),items[1]!]});
    expect(sections.map(section=>section.kind)).toEqual(['images','execution','images']);
  });
});
