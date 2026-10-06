import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRelay } from '../apps/relay/src/server.js';
import { RelayStore } from '../apps/relay/src/storage/store.js';
import { WeixinApi, WeixinError } from '../apps/relay/src/weixin/api.js';
import type { WeixinTransport, WeixinMessage, WeixinCredentials, WeixinQrStatus } from '../apps/relay/src/weixin/api.js';
import { WeixinSecrets, loadWeixinKey } from '../apps/relay/src/weixin/secrets.js';
import { completedTurns } from '../apps/relay/src/weixin/repository.js';
import { testAccount, testAgent } from './account-helpers.js';
import { snapshot, waitFor, WsPeer } from './helpers.js';
import type { DeviceSnapshot, RemoteEvent } from '../packages/protocol/src/index.js';

class FakeWeixin implements WeixinTransport {
  sequence=0;
  confirmations=new Map<string,WeixinQrStatus>();
  messages=new Map<string,WeixinMessage[]>();
  sent:{token:string;peer:string;text:string;context:string;clientId:string}[]=[];
  attempts:{token:string;text:string;clientId:string}[]=[];
  failed=new Set<string>();
  pollFailed=new Set<string>();
  polls:{token:string;cursor:string}[]=[];
  async qr() {const qrcode=`qr-${++this.sequence}`;return {qrcode,qrcode_img_content:`https://liteapp.weixin.qq.com/test?q=${qrcode}`};}
  async qrStatus(_base:string,qrcode:string,_signal:AbortSignal,verifyCode?:string) {
    const result=this.confirmations.get(qrcode)??{status:'wait' as const};
    if(result.status==='need_verifycode'&&verifyCode==='123456')return {status:'confirmed' as const,bot_token:'token-verified',ilink_bot_id:'bot-verified',ilink_user_id:'peer-verified'};
    return result;
  }
  async updates(credentials:WeixinCredentials,cursor:string,signal:AbortSignal) {
    await new Promise(resolve=>setTimeout(resolve,10));
    if(signal.aborted)throw new Error('aborted');
    if(this.pollFailed.has(credentials.token))throw new WeixinError('weixin-session-expired');
    this.polls.push({token:credentials.token,cursor});
    const msgs=this.messages.get(credentials.token)??[];this.messages.delete(credentials.token);
    return {msgs,get_updates_buf:`cursor-${credentials.token}`};
  }
  async send(credentials:WeixinCredentials,peer:string,text:string,context:string,clientId:string) {
    this.attempts.push({token:credentials.token,text,clientId});
    if(this.failed.has(credentials.token))throw new WeixinError('weixin-api-error');
    this.sent.push({token:credentials.token,peer,text,context,clientId});
  }
  message(name:string,text:string,id=randomUUID(),extra:Partial<WeixinMessage>={}) {
    const token=`token-${name}`;
    const message={message_id:id,from_user_id:`peer-${name}`,message_type:1,message_state:2,context_token:`context-${name}`,create_time_ms:Date.now(),item_list:[{type:1,text_item:{text}}],...extra};
    this.messages.set(token,[...(this.messages.get(token)??[]),message]);return message;
  }
}
const closes:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture() {
  const store=await RelayStore.open(),api=new FakeWeixin(),key=randomBytes(32);
  const alice=await testAccount(store,'Alice'),bob=await testAccount(store,'Bob'),admin=await testAccount(store,'Admin','admin');
  const app=await createRelay({store,weixin:{key,api,intervalMs:10},heartbeatMs:50});
  const base=await app.listen({host:'127.0.0.1',port:0}),peers:WsPeer[]=[];
  closes.push(async()=>{for(const p of peers)p.socket.terminate();await app.close();});
  const bind=async(account:typeof alice,name:string,botId=`bot-${name}`)=>{
    const start=await app.inject({method:'POST',url:'/v1/weixin/login',headers:account.headers});expect(start.statusCode).toBe(200);
    api.confirmations.set(`qr-${api.sequence}`,{status:'confirmed',bot_token:`token-${name}`,ilink_bot_id:botId,ilink_user_id:`peer-${name}`,baseurl:'https://ilinkai.weixin.qq.com'});
    const confirmed=await app.inject({method:'POST',url:`/v1/weixin/login/${start.json().loginId}/poll`,headers:account.headers,payload:{}});
    return {start,confirmed};
  };
  const agent=async(account:typeof alice,title:string,idle=false)=>{
    const registered=await testAgent(store,account.id),state=snapshot(registered.id);
    state.threads['thread-test']!.title=title;
    if(idle){state.threads['thread-test']!.status='idle';state.threads['thread-test']!.activeTurnId=null;state.threads['thread-test']!.turns[0]!.status='completed';}
    const p=await WsPeer.open(`${base.replace('http:','ws:')}/v1/ws/device`,{authorization:`Bearer ${registered.token}`,'x-device-id':registered.id});peers.push(p);await p.wait(m=>m.type==='device.welcome');
    p.send({type:'device.catalog',catalog:{protocolVersion:1,deviceId:registered.id,generatedAt:Date.now(),projects:[{id:'project-test',name:`项目-${title}`,roots:['/test'],position:0,updatedAt:1}],threads:[{id:'thread-test',title,cwd:'/test',projectId:'project-test',updatedAt:1,archived:false}]}});
    p.send({type:'device.snapshot',snapshot:state});await waitFor(async()=>!!await store.snapshot(registered.id)&&!!await store.catalog(registered.id));
    return {...registered,state,peer:p};
  };
  const activate=async(name:string,account:typeof alice)=>{api.message(name,'你好');await waitFor(async()=>Boolean((await store.weixin.get(account.id))?.context));await waitFor(()=>api.sent.some(m=>m.token===`token-${name}`));};
  return {store,api,key,app,base,alice,bob,admin,bind,agent,activate};
}
function completion(state:DeviceSnapshot):RemoteEvent {
  const thread=structuredClone(state.threads['thread-test']!);thread.status='idle';thread.activeTurnId=null;thread.turns[0]!.status='completed';
  thread.turns[0]!.items=[{id:'final-test',type:'agentMessage',phase:'final_answer',text:`结果-${thread.title}`,truncated:false}];
  return {protocolVersion:1,deviceId:state.deviceId,epoch:state.epoch,seq:state.lastSeq+1,timestamp:Date.now(),change:{type:'thread.updated',thread}};
}

it('scopes login and settings to the control account, rejects shared bots, and encrypts credentials',async()=>{
  const f=await fixture();
  expect((await f.app.inject({url:'/v1/weixin'})).statusCode).toBe(401);
  expect((await f.app.inject({url:'/v1/weixin',headers:f.admin.headers})).statusCode).toBe(403);
  const a=await f.bind(f.alice,'alice');expect(a.confirmed.statusCode).toBe(200);expect(a.start.json().qrImage).toMatch(/^data:image\/png;base64,/);
  expect((await f.app.inject({method:'POST',url:`/v1/weixin/login/${a.start.json().loginId}/poll`,headers:f.bob.headers,payload:{}})).statusCode).toBe(404);
  const b=await f.bind(f.bob,'bob','bot-alice');expect(b.confirmed.statusCode).toBe(409);expect(b.confirmed.json()).toEqual({error:'weixin-bot-already-bound'});
  expect((await f.store.weixin.get(f.alice.id))?.botId).toBe('bot-alice');expect(await f.store.weixin.get(f.bob.id)).toBeNull();
  const status=await f.app.inject({url:'/v1/weixin',headers:f.alice.headers});expect(status.headers['cache-control']).toBe('no-store');expect(status.body).not.toContain('token-alice');expect(status.body).not.toContain('peer-alice');
  const binding=(await f.store.weixin.get(f.alice.id))!;expect(binding.token).not.toContain('token-alice');
  const vault=new WeixinSecrets(f.key);expect(vault.open(binding.token,`${f.alice.id}:${binding.id}:token`)).toBe('token-alice');expect(()=>vault.open(binding.token,`${f.bob.id}:${binding.id}:token`)).toThrow();
  const device=await testAgent(f.store,f.alice.id);expect((await f.app.inject({url:'/v1/weixin',headers:{authorization:`Bearer ${device.token}`}})).statusCode).toBe(401);
  expect((await f.app.inject({method:'PUT',url:'/v1/weixin',headers:f.alice.headers,payload:{notifications:false,replies:false,userId:f.bob.id}})).statusCode).toBe(400);
  expect((await f.app.inject({method:'POST',url:'/v1/weixin/test',headers:f.alice.headers,payload:{}})).json()).toEqual({error:'weixin-not-activated'});
});

it('supports mobile verification and validates Tencent redirect hosts without leaking tokens',async()=>{
  const f=await fixture();const start=await f.app.inject({method:'POST',url:'/v1/weixin/login',headers:f.alice.headers});
  f.api.confirmations.set(`qr-${f.api.sequence}`,{status:'need_verifycode'});
  const path=`/v1/weixin/login/${start.json().loginId}/poll`;
  expect((await f.app.inject({method:'POST',url:path,headers:f.alice.headers,payload:{}})).json().status).toBe('need_verifycode');
  expect((await f.app.inject({method:'POST',url:path,headers:f.alice.headers,payload:{verifyCode:'123456'}})).json().status).toBe('confirmed');
  const other=await f.app.inject({method:'POST',url:'/v1/weixin/login',headers:f.bob.headers});
  f.api.confirmations.set(`qr-${f.api.sequence}`,{status:'scaned_but_redirect',redirect_host:'127.0.0.1'});
  const response=await f.app.inject({method:'POST',url:`/v1/weixin/login/${other.json().loginId}/poll`,headers:f.bob.headers,payload:{}});
  expect(response.statusCode).toBe(502);expect(response.json()).toEqual({error:'weixin-invalid-host'});
});

it('notifies the correct bots for multiple PCs, deduplicates resyncs, and skips historical/failed turns',async()=>{
  const f=await fixture();await f.bind(f.alice,'alice');await f.bind(f.bob,'bob');
  await f.activate('alice',f.alice);await f.activate('bob',f.bob);
  const a1=await f.agent(f.alice,'Alice-1'),a2=await f.agent(f.alice,'Alice-2'),b=await f.agent(f.bob,'Bob-1');
  await f.agent(f.alice,'Historical',true);
  for(const a of [a1,a2,b])a.peer.send({type:'device.event',event:completion(a.state)});
  await waitFor(()=>f.api.sent.filter(m=>m.text.startsWith('本轮执行完成')).length===3);
  const notices=f.api.sent.filter(m=>m.text.startsWith('本轮执行完成'));
  expect(notices.filter(m=>m.token==='token-alice').map(m=>m.text)).toEqual(expect.arrayContaining([expect.stringContaining('项目-Alice-1'),expect.stringContaining('项目-Alice-2')]));
  expect(notices.filter(m=>m.token==='token-bob')).toHaveLength(1);expect(notices.find(m=>m.token==='token-bob')?.text).toContain('结果-Bob-1');
  expect(notices.every(m=>m.text.includes('编号：C')&&m.peer===m.token.replace('token-','peer-'))).toBe(true);
  a1.peer.send({type:'device.event',event:completion(a1.state)});
  a1.peer.send({type:'device.snapshot',snapshot:(await f.store.snapshot(a1.id))!});
  await waitFor(async()=>!!await f.store.snapshot(a1.id));
  expect(f.api.sent.filter(m=>m.text.startsWith('本轮执行完成'))).toHaveLength(3);
  const before=snapshot();for(const status of ['failed','interrupted','inProgress']) {const after=structuredClone(before);after.threads['thread-test']!.turns[0]!.status=status;expect(completedTurns(before,after)).toEqual([]);}
  const quick=structuredClone(before);quick.threads['thread-test']!.turns[0]={...quick.threads['thread-test']!.turns[0]!,id:'quick-turn',status:'completed',startedAtMs:before.generatedAt,completedAtMs:before.generatedAt+100};
  expect(completedTurns(before,quick)).toHaveLength(1);
  quick.threads['thread-test']!.turns[0]!.startedAtMs=before.generatedAt-600000;expect(completedTurns(before,quick)).toEqual([]);
});

it('routes replies to the explicit account/device/thread, rejects foreign targets and stale or spoofed input, and executes once',async()=>{
  const f=await fixture();await f.bind(f.alice,'alice');await f.bind(f.bob,'bob');await f.activate('alice',f.alice);
  const a=await f.agent(f.alice,'Alice',true),other=await f.agent(f.bob,'Bob',true);
  const target=await f.store.weixin.target(f.alice.id,a.id,'thread-test'),foreign=await f.store.weixin.target(f.bob.id,other.id,'thread-test');
  f.api.message('alice',`继续 ${foreign} secret`);f.api.message('alice',`继续 ${target} stale`,randomUUID(),{create_time_ms:Date.now()-600000});
  f.api.message('alice',`继续 ${target} spoof`,randomUUID(),{from_user_id:'peer-bob',context_token:'stolen'});
  f.api.message('alice',`继续 ${target} group`,randomUUID(),{group_id:'group'});
  await waitFor(()=>f.api.sent.some(m=>m.text.includes('指令已过期'))&&f.api.sent.some(m=>m.text.includes('找不到')));
  expect(a.peer.messages.filter(m=>m.type==='command')).toHaveLength(0);expect(other.peer.messages.filter(m=>m.type==='command')).toHaveLength(0);
  const id=randomUUID();f.api.message('alice',`继续 ${target} 增加登录测试`,id,{message_state:0});f.api.message('alice',`继续 ${target} 增加登录测试`,id,{message_state:0});
  const received=await a.peer.wait(m=>m.type==='command');const command=received.command as {commandId:string;deviceId:string;payload:{type:string;threadId:string;text:string}};
  expect(command).toMatchObject({deviceId:a.id,payload:{type:'turn.start',threadId:'thread-test',text:'增加登录测试'}});
  await waitFor(()=>f.api.sent.some(m=>m.text.includes('已提交续做指令')));
  expect(a.peer.messages.filter(m=>m.type==='command')).toHaveLength(1);
  a.peer.send({type:'command.result',result:{commandId:command.commandId,deviceId:a.id,status:'failed',code:'thread-owner-unavailable'}});
  await waitFor(()=>f.api.sent.some(m=>m.text.includes('这条指令未能执行')));
  const binding=(await f.store.weixin.get(f.alice.id))!;expect(new WeixinSecrets(f.key).open(binding.context!,`${f.alice.id}:${binding.id}:context`)).toBe('context-alice');
});

it('supports account-only session lists and queue requests, while honoring disabled replies and offline PCs',async()=>{
  const f=await fixture();await f.bind(f.alice,'alice');await f.activate('alice',f.alice);
  const a=await f.agent(f.alice,'Alice-active'),b=await f.agent(f.bob,'Bob-private');
  const target=await f.store.weixin.target(f.alice.id,a.id,'thread-test');
  f.api.message('alice','会话');await waitFor(()=>f.api.sent.some(m=>m.text.startsWith('会话 1/')));
  expect(f.api.sent.find(m=>m.text.startsWith('会话 1/'))?.text).toContain(target);expect(f.api.sent.find(m=>m.text.startsWith('会话 1/'))?.text).not.toContain('Bob-private');
  await f.app.inject({method:'PUT',url:'/v1/weixin',headers:f.alice.headers,payload:{notifications:true,replies:false}});
  f.api.message('alice',`继续 ${target} disabled`);await waitFor(()=>f.api.sent.some(m=>m.text.includes('微信续做已关闭')));expect(a.peer.messages.filter(m=>m.type==='command')).toHaveLength(0);
  await f.app.inject({method:'PUT',url:'/v1/weixin',headers:f.alice.headers,payload:{notifications:true,replies:true}});
  f.api.message('alice',`继续 ${target} 排队测试`);const msg=await a.peer.wait(m=>m.type==='command');expect(msg.command).toMatchObject({payload:{type:'turn.queue',text:'排队测试'}});
  await waitFor(()=>f.api.sent.some(m=>m.text.includes('已提交排队请求')));
  f.api.message('alice','直接排队');await waitFor(()=>a.peer.messages.filter(m=>m.type==='command').length===2);
  expect(a.peer.messages.filter(m=>m.type==='command').at(-1)?.command).toMatchObject({payload:{type:'turn.queue',text:'直接排队'}});
  await a.peer.close();f.api.message('alice',`继续 ${target} offline`);await waitFor(()=>f.api.sent.some(m=>m.text.includes('目标电脑离线')));expect(b.peer.messages.filter(m=>m.type==='command')).toHaveLength(0);
});

it('continues the last delivered conversation with plain text and keeps explicit switching and deduplication', async () => {
  const f = await fixture();
  await f.bind(f.alice, 'alice'); await f.bind(f.bob, 'bob'); await f.activate('alice', f.alice);
  const a = await f.agent(f.alice, 'First'), latest = await f.agent(f.alice, 'Latest'), foreign = await f.agent(f.bob, 'Foreign', true);
  const binding = (await f.store.weixin.get(f.alice.id))!;
  f.api.message('alice', '增加登录测试');
  await waitFor(() => f.api.sent.some(m => m.text.includes('还没有可直接回复的会话')));
  expect(a.peer.messages.filter(m => m.type === 'command')).toHaveLength(0);
  a.peer.send({ type: 'device.event', event: completion(a.state) });
  await waitFor(async () => (await f.store.weixin.replyTarget(binding.id, f.alice.id))?.deviceId === a.id);
  latest.peer.send({ type: 'device.event', event: completion(latest.state) });
  await waitFor(async () => (await f.store.weixin.replyTarget(binding.id, f.alice.id))?.deviceId === latest.id);
  const notice = f.api.sent.find(m => m.text.startsWith('本轮执行完成') && m.text.includes('结果-Latest'))!;
  expect(notice.text).toContain('直接回复你的下一步要求即可续做'); expect(notice.text).not.toContain('回复「继续');
  for (const text of ['设备', '会话', '帮助']) f.api.message('alice', text);
  await waitFor(() => f.api.sent.some(m => m.text.startsWith('会话 1/')));
  const id = randomUUID();
  f.api.message('alice', '  增加登录测试\n并检查结果  ', id); f.api.message('alice', '  增加登录测试\n并检查结果  ', id);
  const received = await latest.peer.wait(m => m.type === 'command');
  expect(received.command).toMatchObject({ deviceId: latest.id, payload: { type: 'turn.start', threadId: 'thread-test', text: '增加登录测试\n并检查结果' } });
  await waitFor(() => f.api.sent.some(m => m.text.includes('已提交续做指令') && m.text.includes('Latest')));
  expect(latest.peer.messages.filter(m => m.type === 'command')).toHaveLength(1);
  expect(a.peer.messages.filter(m => m.type === 'command')).toHaveLength(0); expect(foreign.peer.messages.filter(m => m.type === 'command')).toHaveLength(0);
  const target = await f.store.weixin.target(f.alice.id, a.id, 'thread-test');
  f.api.message('alice', `继续 ${target} 切换到第一个会话`); await a.peer.wait(m => m.type === 'command');
  await waitFor(async () => (await f.store.weixin.replyTarget(binding.id, f.alice.id))?.deviceId === a.id);
  f.api.message('alice', '再补上测试');
  await waitFor(() => a.peer.messages.filter(m => m.type === 'command').length === 2);
  expect(a.peer.messages.filter(m => m.type === 'command').at(-1)?.command).toMatchObject({ deviceId: a.id, payload: { text: '再补上测试' } });
  expect(latest.peer.messages.filter(m => m.type === 'command')).toHaveLength(1);
});

it('keeps plain replies on the delivered conversation while another completion fails to send', async () => {
  const f = await fixture(); await f.bind(f.alice, 'alice'); await f.activate('alice', f.alice);
  const delivered = await f.agent(f.alice, 'Delivered'), pending = await f.agent(f.alice, 'Pending');
  const binding = (await f.store.weixin.get(f.alice.id))!;
  delivered.peer.send({ type: 'device.event', event: completion(delivered.state) });
  await waitFor(async () => (await f.store.weixin.replyTarget(binding.id, f.alice.id))?.deviceId === delivered.id);
  f.api.failed.add('token-alice'); pending.peer.send({ type: 'device.event', event: completion(pending.state) });
  await waitFor(async () => (await f.store.weixin.get(f.alice.id))?.sendError === 'weixin-api-error');
  f.api.message('alice', '继续完善这个功能');
  const received = await delivered.peer.wait(m => m.type === 'command');
  expect(received.command).toMatchObject({ deviceId: delivered.id, payload: { text: '继续完善这个功能' } });
  expect(pending.peer.messages.filter(m => m.type === 'command')).toHaveLength(0);
  expect((await f.store.weixin.replyTarget(binding.id, f.alice.id))?.deviceId).toBe(delivered.id);
});

it('checks freshness, sender, settings, and availability for plain replies without falling back', async () => {
  const f = await fixture(); await f.bind(f.alice, 'alice'); await f.activate('alice', f.alice);
  const a = await f.agent(f.alice, 'Latest'), other = await f.agent(f.alice, 'Other', true);
  a.peer.send({ type: 'device.event', event: completion(a.state) });
  const binding = (await f.store.weixin.get(f.alice.id))!;
  await waitFor(async () => (await f.store.weixin.replyTarget(binding.id, f.alice.id))?.deviceId === a.id);
  f.api.message('alice', '过期要求', randomUUID(), { create_time_ms: Date.now() - 600000 });
  f.api.message('alice', '没有时间的要求', randomUUID(), { create_time_ms: undefined });
  f.api.message('alice', '伪造发送者', randomUUID(), { from_user_id: 'peer-bob' }); f.api.message('alice', '群消息', randomUUID(), { group_id: 'group' });
  await waitFor(() => f.api.sent.filter(m => m.text.includes('指令已过期')).length === 2);
  expect(a.peer.messages.filter(m => m.type === 'command')).toHaveLength(0);
  await f.store.weixin.settings(f.alice.id, true, false); f.api.message('alice', '关闭续做后的要求');
  await waitFor(() => f.api.sent.some(m => m.text.includes('微信续做已关闭')));
  await f.store.weixin.settings(f.alice.id, true, true);
  const catalog = (await f.store.catalog(a.id))!; catalog.threads[0]!.archived = true;
  a.peer.send({ type: 'device.catalog', catalog });
  await waitFor(async () => Boolean((await f.store.catalog(a.id))?.threads[0]?.archived));
  f.api.message('alice', '已归档会话的要求'); await waitFor(() => f.api.sent.some(m => m.text.includes('找不到这个账号下的会话编号')));
  await a.peer.close(); f.api.message('alice', '离线后的要求'); await waitFor(() => f.api.sent.some(m => m.text.includes('目标电脑离线')));
  expect(a.peer.messages.filter(m => m.type === 'command')).toHaveLength(0); expect(other.peer.messages.filter(m => m.type === 'command')).toHaveLength(0);
});

it('persists reply targets across restart, follows delivery order, and clears the target on rebinding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-weixin-reply-'));
  let store: RelayStore | undefined;
  try {
    store = await RelayStore.open(undefined, join(directory, 'db'));
    const account = await testAccount(store, 'PersistentReply');
    const first = await testAgent(store, account.id), second = await testAgent(store, account.id), id = randomUUID();
    const binding = { id, userId: account.id, botId: 'reply-bot', peerId: 'reply-peer', baseUrl: 'https://ilinkai.weixin.qq.com', token: 'encrypted-test-token' };
    await store.weixin.bind(binding);
    const one = snapshot(first.id), two = snapshot(second.id);
    await store.saveSnapshot(one); await store.saveEvent(completion(one));
    const older = (await store.weixin.next(id))!;
    await store.saveSnapshot(two); await store.saveEvent(completion(two));
    expect(await store.weixin.replyTarget(id, account.id)).toBeNull();
    await store.weixin.retry(id, older.id, 'weixin-api-error', 1);
    const newer = (await store.weixin.next(id))!; await store.weixin.delivered(id, newer.id);
    expect((await store.weixin.replyTarget(id, account.id))?.deviceId).toBe(second.id);
    await store.weixin.delivered(id, older.id);
    expect((await store.weixin.replyTarget(id, account.id))?.deviceId).toBe(first.id);
    await store.weixin.delivered(id, newer.id);
    expect((await store.weixin.replyTarget(id, account.id))?.deviceId).toBe(first.id);
    await store.close(); store = undefined; store = await RelayStore.open(undefined, join(directory, 'db'));
    expect(await store.weixin.replyTarget(id, account.id)).toMatchObject({ deviceId: first.id, threadId: 'thread-test' });
    expect(await store.weixin.replyTarget(id, 'another-account')).toBeNull();
    await store.weixin.bind({ ...binding, id: randomUUID() });
    expect(await store.weixin.replyTarget(id, account.id)).toBeNull();
    expect(await store.weixin.replyTarget((await store.weixin.get(account.id))!.id, account.id)).toBeNull();
  } finally {
    await store?.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\') && !resolve(directory).startsWith(resolve(tmpdir()) + '/')) throw new Error('unexpected-test-directory');
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps bot failures isolated, retries with a stable ID after a fresh interaction, and stops after account disable/unbind',async()=>{
  const f=await fixture();await f.bind(f.alice,'alice');await f.bind(f.bob,'bob');
  f.api.failed.add('token-alice');f.api.message('alice','你好');await f.activate('bob',f.bob);
  await waitFor(async()=>(await f.store.weixin.get(f.alice.id))?.sendError==='weixin-api-error');
  const first=f.api.attempts.find(m=>m.token==='token-alice')!;expect(f.api.sent.some(m=>m.token==='token-bob')).toBe(true);
  f.api.failed.delete('token-alice');f.api.message('alice','设备');await waitFor(()=>f.api.sent.some(m=>m.clientId===first.clientId));
  expect(f.api.attempts.filter(m=>m.clientId===first.clientId).length).toBeGreaterThanOrEqual(2);
  f.api.pollFailed.add('token-alice');await waitFor(async()=>(await f.store.weixin.get(f.alice.id))?.pollError==='weixin-session-expired');
  f.api.message('bob','设备');await waitFor(()=>f.api.sent.some(m=>m.token==='token-bob'&&m.text.includes('还没有电脑')));
  expect((await f.app.inject({method:'DELETE',url:`/v1/users/${f.alice.id}`,headers:f.admin.headers})).statusCode).toBe(200);expect(await f.store.weixin.get(f.alice.id)).toBeNull();
  expect((await f.app.inject({method:'DELETE',url:'/v1/weixin',headers:f.bob.headers})).statusCode).toBe(200);expect(await f.store.weixin.get(f.bob.id)).toBeNull();
  expect((await f.app.inject({url:'/v1/weixin',headers:f.alice.headers})).statusCode).toBe(401);
});

it('uses Tencent HTTP auth and lossless message IDs, bounds responses, and sanitizes upstream errors',async()=>{
  const fetcher=vi.fn<typeof fetch>();const api=new WeixinApi('0.2.1',fetcher),signal=new AbortController().signal;
  fetcher.mockResolvedValueOnce(new Response('{"ret":0,"msgs":[{"message_id":18446744073709551614,"message_type":1}],"get_updates_buf":"next"}'));
  const updates=await api.updates({token:'secret',baseUrl:'https://ilinkai.weixin.qq.com'},'previous',signal);
  expect(updates.msgs[0]?.message_id).toBe('18446744073709551614');
  const request=fetcher.mock.calls[0]![1]!;expect(request.headers).toMatchObject({Authorization:'Bearer secret',AuthorizationType:'ilink_bot_token','iLink-App-Id':'bot'});
  expect(JSON.parse(request.body as string)).toMatchObject({get_updates_buf:'previous',base_info:{bot_agent:'Codexer/0.2.1'}});
  fetcher.mockResolvedValueOnce(new Response('{"ret":-14,"errmsg":"secret-token-and-personal-data"}'));
  await expect(api.updates({token:'secret',baseUrl:'https://ilinkai.weixin.qq.com'},'',signal)).rejects.toThrow('weixin-session-expired');
  await expect(api.updates({token:'secret',baseUrl:'http://127.0.0.1'},'',signal)).rejects.toThrow('weixin-invalid-host');
  fetcher.mockResolvedValueOnce(new Response('x'.repeat(2*1024*1024+1)));
  await expect(api.updates({token:'secret',baseUrl:'https://ilinkai.weixin.qq.com'},'',signal)).rejects.toThrow('weixin-response-too-large');
});

it('persists encrypted bindings, account targets, and deduplicated pending completions through a database restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'codexer-weixin-test-'));
  let store:RelayStore|undefined;
  try {
    const key=await loadWeixinKey(directory),vault=new WeixinSecrets(key);store=await RelayStore.open(undefined,join(directory,'db'));
    const account=await testAccount(store,'Persistent'),agent=await testAgent(store,account.id),id=randomUUID();
    await store.weixin.bind({id,userId:account.id,botId:'persistent-bot',peerId:'persistent-peer',baseUrl:'https://ilinkai.weixin.qq.com',token:vault.seal('persistent-token',`${account.id}:${id}:token`)});
    const state=snapshot(agent.id);await store.saveSnapshot(state);await store.saveEvent(completion(state));
    const pending=(await store.weixin.next(id))!;expect(pending.text).toContain('本轮执行完成');const target=await store.weixin.target(account.id,agent.id,'thread-test');
    await store.weixin.setThreadNotifications(account.id,agent.id,'thread-separate',true);
    await store.close();store=undefined;
    const restoredKey=await loadWeixinKey(directory);expect(restoredKey).toEqual(key);store=await RelayStore.open(undefined,join(directory,'db'));
    expect(await store.weixin.threadNotifications(account.id,agent.id,'thread-separate')).toBe(true);
    expect(await store.weixin.threadNotifications(account.id,agent.id,'thread-test')).toBe(false);
    const binding=(await store.weixin.get(account.id))!;expect(new WeixinSecrets(restoredKey).open(binding.token,`${account.id}:${id}:token`)).toBe('persistent-token');
    expect((await store.weixin.next(id))?.clientId).toBe(pending.clientId);expect(await store.weixin.target(account.id,agent.id,'thread-test')).toBe(target);
    await store.saveSnapshot((await store.snapshot(agent.id))!);expect(await store.weixin.pending(id)).toBe(1);
    await store.weixin.settings(account.id,false,false);expect(await store.weixin.pending(id)).toBe(0);
    await store.resetPassword(account.id,'changed-password-12345');expect(await store.weixin.get(account.id)).toBeNull();
  } finally {
    await store?.close();
    if(!resolve(directory).startsWith(resolve(tmpdir())+'\\')&&!resolve(directory).startsWith(resolve(tmpdir())+'/'))throw new Error('unexpected-test-directory');
    await rm(directory,{recursive:true,force:true});
  }
});

it('rolls back a completion when enqueue fails and then atomically retries without losing or duplicating a notice',async()=>{
  const store=await RelayStore.open();closes.push(()=>store.close());
  const account=await testAccount(store,'Atomic'),agent=await testAgent(store,account.id),id=randomUUID();
  await store.weixin.bind({id,userId:account.id,botId:'atomic-bot',peerId:'atomic-peer',baseUrl:'https://ilinkai.weixin.qq.com',token:'encrypted-test-value'});
  const state=snapshot(agent.id);await store.saveSnapshot(state);
  const enqueue=vi.spyOn(store.weixin,'completions').mockRejectedValueOnce(new Error('simulated-database-failure'));
  await expect(store.saveEvent(completion(state))).rejects.toThrow('simulated-database-failure');
  expect((await store.snapshot(agent.id))?.lastSeq).toBe(0);expect(await store.weixin.pending(id)).toBe(0);
  enqueue.mockRestore();await store.saveEvent(completion(state));expect((await store.snapshot(agent.id))?.lastSeq).toBe(1);expect(await store.weixin.pending(id)).toBe(1);
});

it('defaults per-thread notifications off, syncs the account across clients, and enforces account/device scope', async () => {
  const f = await fixture(), a = await f.agent(f.alice, 'Selected'), foreign = await f.agent(f.bob, 'Foreign');
  const path = `/v1/devices/${a.id}/threads/thread-test/weixin-notification`;
  const initial = await f.app.inject({url:path,headers:f.alice.headers});
  expect(initial.headers['cache-control']).toBe('no-store');
  expect(initial.json()).toMatchObject({enabled:false,allEnabled:false});
  expect((await f.app.inject({method:'PUT',url:path,headers:f.bob.headers,payload:{enabled:true}})).statusCode).toBe(404);
  expect((await f.app.inject({method:'PUT',url:path,headers:f.admin.headers,payload:{enabled:true}})).statusCode).toBe(403);
  expect((await f.app.inject({method:'PUT',url:path,headers:f.alice.headers,payload:{enabled:true,userId:f.bob.id}})).statusCode).toBe(400);
  const session = (await f.store.createSession(f.alice.id)).session;
  const headers = {authorization:`Bearer ${session}`};
  const peers: WsPeer[] = [];
  closes.push(async()=>{for (const p of peers) p.socket.terminate();});
  for (const h of [f.alice.headers,headers,f.bob.headers]) {
    const ticket = (await f.app.inject({method:'POST',url:'/v1/ws/tickets',headers:h})).json().ticket;
    const peer = await WsPeer.open(f.base.replace('http:','ws:')+'/v1/ws/client');
    peers.push(peer); peer.send({type:'client.authenticate',ticket}); await peer.wait(m=>m.type==='client.authenticated');
  }
  expect((await f.app.inject({method:'PUT',url:path,headers:f.alice.headers,payload:{enabled:true}})).json().enabled).toBe(true);
  for (const p of peers.slice(0,2)) expect((await p.wait(m=>m.type==='weixin.thread-notification')).notification).toMatchObject({enabled:true});
  expect(peers[2]!.messages.some(m=>m.type==='weixin.thread-notification')).toBe(false);
  expect((await f.app.inject({url:path,headers})).json().enabled).toBe(true);
  expect((await f.app.inject({url:`/v1/devices/${foreign.id}/threads/thread-test/weixin-notification`,headers:f.bob.headers})).json().enabled).toBe(false);
  await f.bind(f.alice,'alice');
  await f.app.inject({method:'PUT',url:'/v1/weixin',headers:f.alice.headers,payload:{notifications:false,replies:true}});
  for (const p of peers.slice(0,2)) expect((await p.wait(m=>m.type==='weixin.settings')).status).toMatchObject({notifications:false});
  expect(peers[2]!.messages.some(m=>m.type==='weixin.settings')).toBe(false);
  expect((await f.app.inject({url:path,headers})).json()).toMatchObject({enabled:true,allEnabled:false});
});

it('sends only opted-in sessions with the global switch off, and all sessions with it on', async () => {
  const f = await fixture(); await f.bind(f.alice,'alice'); await f.activate('alice',f.alice);
  await f.store.weixin.settings(f.alice.id,false,true);
  const selected = await f.agent(f.alice,'Selected'), silent = await f.agent(f.alice,'Silent');
  await f.store.weixin.setThreadNotifications(f.alice.id,selected.id,'thread-test',true);
  await f.store.saveEvent(completion(selected.state)); await f.store.saveEvent(completion(silent.state));
  await waitFor(()=>f.api.sent.some(m=>m.text.includes('结果-Selected')));
  expect(f.api.sent.filter(m=>m.text.startsWith('本轮执行完成'))).toHaveLength(1);
  expect(f.api.sent.some(m=>m.text.includes('结果-Silent'))).toBe(false);
  await f.store.weixin.settings(f.alice.id,true,true);
  const all = await f.agent(f.alice,'Global');
  expect(await f.store.weixin.threadNotifications(f.alice.id,all.id,'thread-test')).toBe(false);
  await f.store.saveEvent(completion(all.state));
  await waitFor(()=>f.api.sent.some(m=>m.text.includes('结果-Global')));
  expect(f.api.sent.filter(m=>m.text.startsWith('本轮执行完成'))).toHaveLength(2);
});

it('keeps opted-in pending completions when global notifications are disabled and removes them when that session is disabled', async () => {
  const f = await fixture(); await f.bind(f.alice,'alice');
  const a = await f.agent(f.alice,'A'), b = await f.agent(f.alice,'B');
  await f.store.weixin.setThreadNotifications(f.alice.id,a.id,'thread-test',true);
  await f.store.saveEvent(completion(a.state)); await f.store.saveEvent(completion(b.state));
  const binding = (await f.store.weixin.get(f.alice.id))!;
  expect(await f.store.weixin.pending(binding.id)).toBe(2);
  await f.store.weixin.settings(f.alice.id,false,true);
  expect(await f.store.weixin.pending(binding.id)).toBe(1);
  expect((await f.store.weixin.next(binding.id))?.text).toContain('结果-A');
  await f.store.weixin.setThreadNotifications(f.alice.id,a.id,'thread-test',false);
  expect(await f.store.weixin.pending(binding.id)).toBe(0);
  await f.store.weixin.settings(f.alice.id,true,true);
  const c = await f.agent(f.alice,'C'); await f.store.saveEvent(completion(c.state));
  await f.store.weixin.setThreadNotifications(f.alice.id,c.id,'thread-test',false);
  expect(await f.store.weixin.pending(binding.id)).toBe(1);
});
