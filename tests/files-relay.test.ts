import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { PcAgent } from '../apps/pc-agent/src/agent.js';
import { createRelay } from '../apps/relay/src/server.js';
import { RelayStore } from '../apps/relay/src/storage/store.js';
import { FILE_CHUNK_BYTES } from '../packages/protocol/src/files.js';
import { testAccount, testAgent } from './account-helpers.js';
import { FakeDesktop, snapshot, waitFor, WsPeer } from './helpers.js';

it('retrieves live and historical files through a real PC Agent with account/thread isolation and no Relay persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-file-relay-'));
  const desktop = new FakeDesktop(), store = await RelayStore.open(), account = await testAccount(store), other = await testAccount(store,'Other');
  const app = await createRelay({store});
  let agent: PcAgent | undefined;
  try {
    const path = join(directory,'文档 with spaces.md').replaceAll('\\','/'), archive = join(directory,'archive.zip').replaceAll('\\','/'), historical = join(directory,'old.json').replaceAll('\\','/');
    const body = '# 测试文档\n\n已从 PC 读取。', binary = Buffer.alloc(FILE_CHUNK_BYTES * 2 + 71, 123);
    await Promise.all([writeFile(path,body),writeFile(archive,binary),writeFile(historical,'{"ok":true}')]);
    const turns = desktop.state.turnHistory as {history:{entitiesByKey: Record<string,{items:unknown[]}>}};
    const citation = process.platform === 'win32' ? '/' + path : path;
    turns.history.entitiesByKey['turn-key']!.items = [{id:'final',type:'agentMessage',text:`[文档](<${citation}>)\n\n[压缩包](<${archive}>)`,phase:'final_answer'}];
    await desktop.start();
    const base = await app.listen({host:'127.0.0.1',port:0}), registered = await testAgent(store,account.id);
    const credentials = {relayUrl:base,deviceId:registered.id,session:registered.token,installationId:'test',username:account.name,expiresAt:Date.now()+60000};
    const reader = {
      list: async () => ({protocolVersion:1 as const,deviceId:registered.id,generatedAt:Date.now(),projects:[],threads:[{id:'thread-test',title:'Files',cwd:null,projectId:null,updatedAt:1,archived:false},{id:'other-thread',title:'Other',cwd:null,projectId:null,updatedAt:1,archived:false}]}),
      history: async (threadId:string) => ({threadId,generatedAt:Date.now(),nextCursor:null,turns:[{id:'old',status:'completed',truncated:false,items:[{id:'old-final',type:'agentMessage',text:`[历史文件](<${historical}>)`,truncated:false}]}]}),
    };
    agent = new PcAgent(credentials,directory,['thread-test'],desktop.endpoint,join(directory,'empty'),'desktop',reader);
    await agent.start();
    await waitFor(async()=>!!(await store.catalog(registered.id)) && !!(await store.snapshot(registered.id))?.threads['thread-test']?.turns[0]?.items.length);
    const url = (kind:string,value=path,thread='thread-test') => `/v1/devices/${registered.id}/threads/${thread}/files/${kind}?path=${encodeURIComponent(value)}`;
    const info = await app.inject({url:url('info'),headers:account.headers});
    expect(info.statusCode).toBe(200); expect(info.json()).toMatchObject({name:'文档 with spaces.md',size:Buffer.byteLength(body)}); expect(info.json().base64).toBeUndefined();
    const citationInfo = await app.inject({url:url('info',citation),headers:account.headers});
    expect(citationInfo.statusCode).toBe(200); expect(citationInfo.json()).toEqual(info.json());
    const content = await app.inject({url:url('content')+`&version=${info.json().version}`,headers:account.headers});
    expect(content.statusCode).toBe(200); expect(content.body).toBe(body); expect(content.headers['content-disposition']).toContain('filename*=UTF-8');
    expect(content.headers['cache-control']).toBe('no-store');
    const zipInfo = await app.inject({url:url('info',archive),headers:account.headers});
    const zip = await app.inject({url:url('content',archive)+`&version=${zipInfo.json().version}`,headers:account.headers});
    expect(zip.statusCode).toBe(200); expect(zip.rawPayload).toEqual(binary);
    expect((await app.inject({url:url('info')})).statusCode).toBe(401);
    expect((await app.inject({url:url('info'),headers:other.headers})).statusCode).toBe(404);
    expect((await app.inject({url:url('info',path,'other-thread'),headers:account.headers})).json().error).toBe('file-not-in-thread');
    expect((await app.inject({url:url('info',join(directory,'commands.sqlite')),headers:account.headers})).statusCode).toBe(404);
    expect((await app.inject({url:url('info',historical),headers:account.headers})).statusCode).toBe(404);
    expect((await app.inject({url:`/v1/devices/${registered.id}/threads/thread-test/turns`,headers:account.headers})).statusCode).toBe(200);
    expect((await app.inject({url:url('info',historical),headers:account.headers})).statusCode).toBe(200);
    await writeFile(path,'changed');
    expect((await app.inject({url:url('content')+`&version=${info.json().version}`,headers:account.headers})).json().error).toBe('file-changed');
    expect(JSON.stringify(await store.snapshot(registered.id))).not.toContain(binary.toString('base64'));
    expect(JSON.stringify(await store.snapshot(registered.id))).not.toContain(body);
    agent.disconnect();
    await waitFor(async()=>(await app.inject({url:'/v1/devices',headers:account.headers})).json().devices.find((d:{id:string})=>d.id===registered.id)?.online===false);
    expect((await app.inject({url:url('info'),headers:account.headers})).json().error).toBe('device-offline');
  } finally {
    await agent?.stop(); await app.close(); await desktop.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('unexpected-test-directory');
    await rm(directory,{recursive:true,force:true});
  }
});

it('reports an old Agent explicitly, and cancels pending requests on HTTP disconnect', async () => {
  const store = await RelayStore.open(), account = await testAccount(store), admin = await testAccount(store,'Admin','admin'), registered = await testAgent(store,account.id), app = await createRelay({store});
  let peer: WsPeer | undefined;
  try {
    const base = await app.listen({host:'127.0.0.1',port:0});
    peer = await WsPeer.open(`${base.replace('http:','ws:')}/v1/ws/device`,{authorization:`Bearer ${registered.token}`,'x-device-id':registered.id});
    await peer.wait(m=>m.type==='device.welcome');
    peer.send({type:'device.snapshot',snapshot:snapshot(registered.id)});
    peer.send({type:'device.catalog',catalog:{protocolVersion:1,deviceId:registered.id,generatedAt:Date.now(),projects:[],threads:[{id:'thread-test',title:'Files',cwd:null,projectId:null,updatedAt:1,archived:false}]}});
    await waitFor(async()=>!!await store.catalog(registered.id));
    const url = `/v1/devices/${registered.id}/threads/thread-test/files/info?path=C%3A%2Ftest.txt`;
    expect((await app.inject({url,headers:account.headers})).json().error).toBe('agent-update-required');
    peer.send({type:'device.capabilities',features:['files']});
    const controller = new AbortController();
    const pending = fetch(base+url,{headers:account.headers,signal:controller.signal}).catch(()=>undefined);
    const request = await peer.wait(m=>m.type==='file.request');
    controller.abort(); await pending;
    await waitFor(async()=>(await app.inject({url:'/v1/admin/metrics',headers:admin.headers})).json().connections.pendingFiles===0);
    // A late response belongs to the cancelled request and must not affect a new one.
    peer.send({type:'device.file',requestId:request.requestId,threadId:'thread-test',path:'C:/test.txt',file:null,code:'file-unavailable'});
    const second = app.inject({url,headers:account.headers});
    const next = await peer.wait(m=>m.type==='file.request'&&m.requestId!==request.requestId);
    peer.send({type:'device.file',requestId:next.requestId,threadId:'thread-test',path:'C:/test.txt',file:{name:'test.txt',size:0,version:'a'.repeat(64)},code:null});
    expect((await second).statusCode).toBe(200);
  } finally { peer?.socket.terminate(); await app.close(); }
});
