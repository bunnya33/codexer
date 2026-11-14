import {describe, expect, it} from 'vitest';
import {activitySections, collaborationSummary, completedActivityLabel, executionItemActive, imageActivitySummary, mergeLiveTurn, splitActivityReply} from '../packages/client-shared/src/activity.js';
import {normalizeHistoryTurn, normalizeThread} from '../packages/codex-adapter/src/normalize.js';
import {historyTurnSchema, threadSchema} from '../packages/protocol/src/index.js';
import type {HistoryTurn, RemoteItem, RemoteSubAgent} from '../packages/protocol/src/index.js';

const child: RemoteSubAgent = {threadId: 'child', name: 'Linnaeus', status: 'running', statusSource: 'activity'};
const item = (id: string, type: string, rest: Partial<RemoteItem> = {}): RemoteItem => ({id, type, truncated: false, ...rest});

describe('inline Codex activity records', () => {
  it('keeps all file operations with adjacent commands and tools while retaining milestone boundaries', () => {
    const progress=item('progress','agentMessage',{phase:'commentary'});
    const execution=[item('command','commandExecution'),item('create','fileChange',{fileOperations:[{path:'new.ts',kind:'add'}]}),
      item('edit','fileChange',{fileOperations:[{path:'edit.ts',kind:'update'}]}),item('delete','fileChange',{fileOperations:[{path:'old.ts',kind:'delete'}]}),
      item('tool','mcpToolCall'),item('after','commandExecution')];
    const block={kind:'activity' as const,id:'work',state:'running' as const,items:[progress,...execution]};
    const initial=activitySections({...block,items:[progress,execution[0]!]});
    const sections=activitySections(block);
    expect(sections).toHaveLength(2);
    expect(sections[1]).toMatchObject({kind:'execution',id:initial[1]!.kind==='execution'?initial[1]!.id:'',items:execution,running:true});
    const separated=activitySections({...block,items:[...block.items,item('compact','contextCompaction'),item('next','commandExecution'),
      item('steer','steeringUserMessage'),item('plan','plan'),item('last','commandExecution')]});
    expect(separated.map(section=>section.kind)).toEqual(['message','execution','compaction','execution','message','message','execution']);
  });
  it('folds the entire completed process while leaving the initial prompt and trailing final reply outside', () => {
    const process = [item('progress','agentMessage',{phase:'commentary'}),item('old-final','agentMessage',{phase:'final_answer'}),
      item('steering','steeringUserMessage'),item('spawn','subAgentActivity'),item('view','imageView'),item('edit','fileChange'),item('compact','contextCompaction')];
    const final = item('final','agentMessage',{phase:'final_answer'});
    const block = {kind:'activity' as const,id:'work',state:'completed' as const,durationMs:3052000,items:[...process,final]};
    expect(splitActivityReply(block)).toEqual({process,final:[final]});
    expect(completedActivityLabel(block)).toBe('用时 50m 52s');
    expect(splitActivityReply({...block,state:'running',items:process})).toEqual({process,final:[]});
    expect(splitActivityReply({...block,items:[item('legacy','agentMessage')]}).final).toHaveLength(1);
    const commentary = item('commentary','agentMessage',{phase:'commentary',text:'已完成处理'});
    expect(splitActivityReply({...block,items:[commentary]})).toEqual({process:[],final:[commentary]});
  });
  it('keeps a final reply visible when a tool finishes after it and does not expose an earlier reply before steering', () => {
    const final = item('final','agentMessage',{phase:'final_answer',text:'交付结果'});
    const tool = item('late-tool','mcpToolCall',{status:'completed'});
    const block = {kind:'activity' as const,id:'work',state:'completed' as const,items:[final,tool]};
    expect(splitActivityReply(block)).toEqual({process:[tool],final:[final]});
    const steer = item('steer','steeringUserMessage',{text:'追加要求'});
    expect(splitActivityReply({...block,items:[final,steer,tool]})).toEqual({process:[final,steer,tool],final:[]});
    const progress = item('progress','agentMessage',{phase:'commentary',text:'Mac 上记录的回复'});
    expect(splitActivityReply({...block,items:[final,steer,progress,tool]})).toEqual({process:[final,steer,tool],final:[progress]});
  });
  it('retains long-turn activities through successive windows, then restores every split history page', () => {
    const records = [item('start','subAgentActivity'), item('image','imageView'), item('compact','contextCompaction'), item('edit','fileChange'),
      ...Array.from({length:180}, (_, i) => item(`command-${i}`, 'commandExecution'))];
    const turn = (items: RemoteItem[], before: boolean, after = false): HistoryTurn => ({id:'turn',status:'inProgress',items,truncated:before||after,itemsTruncatedBefore:before,itemsTruncatedAfter:after});
    let seen = turn(records.slice(0,20),false);
    for (let i=20;i<records.length;i+=20) seen = mergeLiveTurn(seen, turn(records.slice(i,i+20),true),true);
    expect(seen.items.map(item=>item.id)).toEqual(records.map(item=>item.id));
    let restored = turn(records.slice(-80),true);
    restored = mergeLiveTurn(restored,turn(records.slice(24,104),true,true),true);
    restored = mergeLiveTurn(restored,turn(records.slice(0,24),false,true),true);
    expect(restored.items.map(item=>item.id)).toEqual(records.map(item=>item.id));
    expect(restored).toMatchObject({itemsTruncatedBefore:false,itemsTruncatedAfter:false,truncated:false});
    const sections = activitySections({kind:'activity',id:'work',state:'completed',items:restored.items});
    expect(sections.map(section=>section.kind)).toEqual(['collaboration','images','compaction','execution']);
  });

  it('carries per-edit line counts without forwarding private tool arguments', () => {
    const turn = normalizeHistoryTurn({id:'turn',items:[{id:'edit',type:'fileChange',status:'completed',changes:[
      {path:'test.ts',kind:{type:'update'},diff:'--- a\n+++ b\n@@ -1 +1,2 @@\n-old\n+new\n+next\n'},
      {path:'new.txt',kind:'add',diff:'first\nsecond\n'},
    ],arguments:{secret:'private'}}]});
    expect(historyTurnSchema.parse(turn).items[0]!.fileOperations).toEqual([
      {path:'test.ts',kind:'update',additions:2,deletions:1}, {path:'new.txt',kind:'add',additions:2,deletions:0},
    ]);
    expect(JSON.stringify(turn)).not.toContain('private');
  });
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
