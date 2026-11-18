import type {CommandResult} from '../../../packages/protocol/src/index';

export type EditDelivery={status:'idle'|'unknown'|'sent';threadId?:string};
/** A lost acknowledgement must never turn an edit into a second fork. */
export async function deliverMessageEdit(state:EditDelivery,send:()=>Promise<CommandResult>):Promise<string>{
  if(state.status==='sent'&&state.threadId)return state.threadId;
  if(state.status==='unknown')throw new Error('发送结果待确认，请检查会话列表。');
  state.status='unknown';
  const result=await send();
  if(result.status==='succeeded'&&typeof result.result?.threadId==='string'){
    state.status='sent';state.threadId=result.result.threadId;return state.threadId;
  }
  if(result.status==='unknown'||result.status==='succeeded')throw new Error('发送结果待确认，请检查会话列表。');
  state.status='idle';
  const errors:Record<string,string>={'edit-message-changed':'消息内容已变化，请关闭后重新编辑。','edit-message-unavailable':'此消息暂不支持编辑重发。','thread-not-idle':'请等待当前任务结束后再编辑。','edit-runtime-unsupported':'当前 Codex 运行时不支持编辑重发，请更新后重试。'};
  throw new Error(errors[result.code]??result.code);
}
