import {describe, expect, it} from 'vitest';
import {normalizeHistoryTurn, normalizeThread} from '../packages/codex-adapter/src/normalize.js';
import {historyTurnSchema, threadSchema} from '../packages/protocol/src/index.js';
import {displayCommand, executionItemIcon, executionItemSummary, executionSectionSummary} from '../packages/client-shared/src/activity.js';
import type {RemoteItem} from '../packages/protocol/src/index.js';

const item = (rest: Partial<RemoteItem>): RemoteItem => ({id:'item',type:'mcpToolCall',truncated:false,...rest});
const browser = {id:'browser',type:'mcpToolCall',server:'cua_repl',tool:'js',status:'inProgress',arguments:{title:'检查弹层最终布局',code:'private page script'},result:{content:'private page content'}};

describe('Codex public activity presentation', () => {
  it('preserves the browser title in live snapshots, history and transport without forwarding arguments or results', () => {
    const turn = {id:'turn',status:'inProgress',items:[browser]};
    const live = threadSchema.parse(normalizeThread({id:'thread',turns:[turn],threadRuntimeStatus:{type:'active'}},1));
    const history = historyTurnSchema.parse(normalizeHistoryTurn(turn));
    for(const value of [live.turns[0]!.items[0]!, history.items[0]!]) {
      expect(value).toMatchObject({activityTitle:'检查弹层最终布局',toolServer:'cua_repl'});
      expect(executionItemSummary(value,true)).toBe('检查弹层最终布局');
      expect(executionItemIcon(value)).toBe('browser');
      expect(JSON.stringify(value)).not.toContain('private page');
    }
  });
  it('keeps completion titles and failure states, and limits activity metadata', () => {
    const values = normalizeHistoryTurn({id:'t',items:[
      {...browser,arguments:{completion_summary:'已验证模型弹层上移'},status:'completed'},
      {...browser,id:'failed',status:'failed'},
      {...browser,id:'long',arguments:{title:'a'.repeat(400)},server:'s'.repeat(400)},
    ]}).items;
    expect(executionItemSummary(values[0],false)).toBe('已验证模型弹层上移');
    expect(executionItemSummary(values[1],false)).toBe('失败：检查弹层最终布局');
    expect(values[2]!.toolServer).toHaveLength(300);
    expect(values[2]!.activityTitle).toBeUndefined();
    expect(normalizeHistoryTurn({id:'t',items:[{...browser,arguments:{title:'a'.repeat(400)}}]}).items[0]!.activityTitle).toHaveLength(300);
  });
  it('uses localized chat operations, including old snapshots, without renaming another MCP server tool', () => {
    for(const tool of ['read_thread','mcp__codex_app__read_thread']) {
      expect(executionItemSummary(item({tool,status:'completed'}),false)).toBe('已读取聊天');
      expect(executionItemSummary(item({tool,status:'inProgress'}),true)).toBe('正在读取聊天');
      expect(executionItemIcon(item({tool}))).toBe('chat');
    }
    expect(executionItemSummary(item({tool:'read_thread',toolServer:'other'}),false)).toBe('已调用read_thread');
    expect(executionItemSummary(item({tool:'unknown_tool'}),true)).toBe('正在调用unknown_tool');
    expect(executionItemSummary(item({type:'reasoning'}),true)).toBe('正在思考');
  });
  it('shows the parsed command while retaining the full launcher command in details', () => {
    const command='"C:\\runtime\\pwsh.exe" -Command "Get-ChildItem -LiteralPath C:/Users/JOKER/.codex -Force"';
    const value=normalizeHistoryTurn({id:'t',items:[{id:'c',type:'commandExecution',command,commandActions:[{type:'unknown',command:'Get-ChildItem -LiteralPath C:/Users/JOKER/.codex -Force'}]}]}).items[0]!;
    expect(value.command).toBe(command);
    expect(executionItemSummary(value,false)).toBe('已运行 Get-ChildItem -LiteralPath C:/Users/JOKER/.codex -Force');
    expect(executionItemSummary({...value,commandPreview:undefined},false)).toBe(executionItemSummary(value,false));
    expect(displayCommand('pwsh -NoProfile -Command "Get-Location\nGet-Date"')).toBe('Get-Location\nGet-Date');
    expect(displayCommand("bash -lc 'npm test'")).toBe('npm test');
    expect(displayCommand('cmd.exe /d /c "dir"')).toBe('dir');
    expect(displayCommand('node -e "run()"')).toBe('node -e "run()"');
    expect(displayCommand('echo "pwsh -Command test"')).toBe('echo "pwsh -Command test"');
    expect(displayCommand('pwsh -EncodedCommand abc')).toBe('pwsh -EncodedCommand abc');
  });
  it('retains the named browser activity across empty reasoning placeholders and preserves public thinking summaries verbatim', () => {
    const browserItem=item({tool:'js',toolServer:'cua_repl',activityTitle:'检查弹层最终布局',status:'inProgress'});
    const empty=item({id:'empty',type:'reasoning'});
    const section={kind:'execution' as const,id:'s',items:[browserItem,empty],running:true};
    expect(executionSectionSummary(section)).toBe('检查弹层最终布局');
    const thinking=item({id:'thinking',type:'reasoning',text:'**Testing mobile layout**'});
    expect(executionSectionSummary({...section,items:[thinking,{...browserItem,status:'completed'},empty],running:false})).toBe('Testing mobile layout');
    expect(executionItemSummary(thinking,true)).toBe('Testing mobile layout');
    expect(executionItemSummary(item({type:'imageView'}),false)).toBe('已查看图片');
    expect(executionItemSummary(item({type:'contextCompaction'}),true)).toBe('正在压缩上下文');
    expect(executionItemSummary(item({type:'sleep',status:'inProgress',durationMs:1000}),true)).toBe('正在等待');
  });
});
