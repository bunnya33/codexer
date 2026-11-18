import {expect,it,vi} from 'vitest';
import {messagePlainText,messageTextRuns} from '../packages/client-shared/src/message-text';
import {deliverMessageEdit,type EditDelivery} from '../apps/mobile/src/message-edit-delivery';
import type {CommandResult} from '../packages/protocol/src/index';

it('keeps paragraphs, nested list order, headings and formatting in one selection string',()=>{
  const source='# 标题\n\n第一段 **加粗**，*斜体*和 `代码`。\n\n第二段 [链接](https://example.com)。\n\n3. 第三项\n   - 子项\n4. 第四项';
  const runs=messageTextRuns(source)!;
  expect(runs.map(r=>r.text).join('')).toBe('标题\n\n第一段 加粗，斜体和 代码。\n\n第二段 链接。\n\n3. 第三项\n  • 子项\n4. 第四项');
  expect(runs.find(r=>r.text==='标题')?.heading).toBe(1);
  expect(runs.find(r=>r.text==='加粗')?.bold).toBe(true);
  expect(runs.find(r=>r.text==='代码')?.code).toBe(true);
  expect(runs.find(r=>r.text==='链接')?.link).toBe('https://example.com');
});
it('preserves rich code/table rendering and still copies all paragraphs and code',()=>{
  expect(messageTextRuns('第一段\n\n```js\nconst x=1;\n```\n\n最后一段')).toBeNull();
  expect(messagePlainText('第一段\n\n```js\nconst x=1;\n```\n\n最后一段')).toContain('const x=1;');
  expect(messageTextRuns('|A|B|\n|---|---|\n|1|2|')).toBeNull();
});
const result=(status:CommandResult['status'],extra:Partial<CommandResult>={})=>({commandId:'test',status,code:'test',...extra} as CommandResult);
it('never resends a confirmed edit when subsequent catalog loading fails',async()=>{
  const state:EditDelivery={status:'idle'},send=vi.fn().mockResolvedValue(result('succeeded',{result:{threadId:'fork'}}));
  expect(await deliverMessageEdit(state,send)).toBe('fork');
  expect(await deliverMessageEdit(state,send)).toBe('fork');
  expect(send).toHaveBeenCalledTimes(1);
});
it.each(['unknown','throw'] as const)('blocks retry after %s delivery outcome',async mode=>{
  const state:EditDelivery={status:'idle'},send=vi.fn().mockImplementation(async()=>{if(mode==='throw')throw new Error('connection-lost');return result('unknown');});
  await expect(deliverMessageEdit(state,send)).rejects.toThrow();
  await expect(deliverMessageEdit(state,send)).rejects.toThrow('结果待确认');
  expect(send).toHaveBeenCalledTimes(1);
});
it('allows correction after a confirmed pre-fork rejection',async()=>{
  const state:EditDelivery={status:'idle'},send=vi.fn().mockResolvedValueOnce(result('failed',{code:'edit-message-changed'})).mockResolvedValueOnce(result('succeeded',{result:{threadId:'fork'}}));
  await expect(deliverMessageEdit(state,send)).rejects.toThrow('消息内容已变化');
  expect(await deliverMessageEdit(state,send)).toBe('fork');
});
