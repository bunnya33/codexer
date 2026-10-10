import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { createRelay } from '../apps/relay/src/server.js';
import { RelayStore } from '../apps/relay/src/storage/store.js';
import { PcAgent } from '../apps/pc-agent/src/agent.js';
import { testAccount, testAgent } from './account-helpers.js';
import { FakeDesktop, waitFor } from './helpers.js';

it('previews a real local app through Agent/Relay with assets, API bytes, cookies, WebSocket and session revocation', async () => {
  const directory=await mkdtemp(join(tmpdir(),'codexer-preview-relay-'));
  let eventsClosed=false;
  const upstream=createServer((req,res)=>{
    if(req.url==='/src/main.js'){res.setHeader('content-type','application/javascript');res.end('import "/src/next.js";window.ready=true;');}
    else if(req.url==='/logo.svg'){res.setHeader('content-type','image/svg+xml');res.end('<svg/>');}
    else if(req.url==='/api'){const chunks:Buffer[]=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({body:Buffer.concat(chunks).toString(),cookie:req.headers.cookie??'',authorization:req.headers.authorization??''}));});}
    else if(req.url==='/nested/redirect'){res.writeHead(302,{location:'./page.html?view=1#tab'});res.end();}
    else if(req.url==='/external-redirect'){res.writeHead(302,{location:'https://example.com/'});res.end();}
    else if(req.url==='/events'){res.setHeader('content-type','text/event-stream');res.write('data: ready\n\n');res.on('close',()=>{eventsClosed=true;});}
    else {res.setHeader('content-type','text/html');res.setHeader('set-cookie','demo=local; Path=/');res.end('<html><head></head><body><script type="module" src="/src/main.js"></script><img src="/logo.svg"><button>预览</button></body></html>');}
  });
  const wss=new WebSocketServer({server:upstream});wss.on('connection',socket=>socket.on('message',(data,binary)=>socket.send(data,{binary})));
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const address=upstream.address() as {port:number}, source=`http://localhost:${address.port}/`;
  const desktop=new FakeDesktop(),store=await RelayStore.open(),account=await testAccount(store),other=await testAccount(store,'Other');
  const app=await createRelay({store});let agent:PcAgent|undefined,ws:WebSocket|undefined;const eventsAbort=new AbortController();
  try{
    const turns=desktop.state.turnHistory as {history:{entitiesByKey:Record<string,{items:unknown[]}>}};
    turns.history.entitiesByKey['turn-key']!.items=[{id:'final',type:'agentMessage',text:`[打开预览](${source})`,phase:'final_answer'}];
    await desktop.start();const base=await app.listen({host:'127.0.0.1',port:0}),registered=await testAgent(store,account.id);
    const reader={list:async()=>({protocolVersion:1 as const,deviceId:registered.id,generatedAt:Date.now(),projects:[],threads:[{id:'thread-test',title:'Preview',cwd:null,projectId:null,updatedAt:1,archived:false}]}),history:async()=>({threadId:'thread-test',generatedAt:Date.now(),nextCursor:null,turns:[]})};
    agent=new PcAgent({relayUrl:base,deviceId:registered.id,session:registered.token,installationId:'test',username:account.name,expiresAt:Date.now()+60000},directory,['thread-test'],desktop.endpoint,join(directory,'empty'),'desktop',reader);
    await agent.start();await waitFor(async()=>!!(await store.catalog(registered.id))&&!!(await store.snapshot(registered.id))?.threads['thread-test']?.turns[0]?.items.length);
    const endpoint=`/v1/devices/${registered.id}/threads/thread-test/previews`;
    const create=()=>app.inject({method:'POST',url:endpoint,headers:account.headers,payload:{url:source,channel:'test-channel',state:{modelContent:{test:true}}}});
    let result=await create();if(result.json().error==='agent-update-required'){await new Promise(resolve=>setTimeout(resolve,30));result=await create();}
    expect(result.statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:endpoint,headers:other.headers,payload:{url:source,channel:'x'}})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:endpoint,headers:account.headers,payload:{url:'http://192.168.0.2/',channel:'x'}})).statusCode).toBe(400);
    const path=result.json().path as string;
    const html=await app.inject({url:path});expect(html.statusCode).toBe(200);expect(html.body).toContain(path+'src/main.js');expect(html.body).toContain('test-channel');
    expect(html.headers['content-security-policy']).toContain('sandbox allow-scripts');expect(html.headers['access-control-allow-origin']).toBe('*');expect(html.headers['set-cookie']).toBeUndefined();
    const js=await app.inject({url:path+'src/main.js'});expect(js.body).toContain(path+'src/next.js');
    const api=await app.inject({method:'POST',url:path+'api',headers:{'content-type':'application/json',...account.headers},payload:'{ "n": 2 }'});
    expect(api.statusCode).toBe(200);expect(api.json()).toEqual({body:'{ "n": 2 }',cookie:'demo=local',authorization:''});
    expect((await app.inject({url:path+'logo.svg'})).body).toBe('<svg/>');
    expect((await app.inject({url:path+'nested/redirect'})).headers.location).toBe(path+'nested/page.html?view=1#tab');
    expect((await app.inject({url:path+'external-redirect'})).statusCode).toBe(502);
    ws=new WebSocket(base.replace(/^http/,'ws')+path+'__socket?path=%2F');
    const echo=new Promise<string>((resolve,reject)=>{ws!.once('open',()=>ws!.send('hmr'));ws!.once('message',data=>resolve(data.toString()));ws!.once('error',reject);});
    expect(await echo).toBe('hmr');ws.close();
    const forbidden=await app.inject({method:'POST',url:endpoint,headers:account.headers,payload:{url:'http://localhost:1/',channel:'x'}});
    expect((await app.inject({url:forbidden.json().path})).json().error).toBe('preview-not-in-thread');
    const discard=await create(); const discardPath=discard.json().path as string;
    expect((await app.inject({method:'DELETE',url:discardPath.replace(/\/$/,''),headers:other.headers})).statusCode).toBe(404);
    expect((await app.inject({method:'DELETE',url:discardPath.replace(/\/$/,''),headers:account.headers})).statusCode).toBe(200);
    expect((await app.inject({url:discardPath})).statusCode).toBe(410);
    expect(JSON.stringify(await store.snapshot(registered.id))).not.toContain('demo=local');
    const events=await fetch(base+path+'events',{signal:eventsAbort.signal});
    expect(events.headers.get('content-type')).toContain('text/event-stream');
    const readerEvents=events.body!.getReader();
    expect(new TextDecoder().decode((await readerEvents.read()).value)).toContain('data: ready');
    ws=new WebSocket(base.replace(/^http/,'ws')+path+'__socket?path=%2F');
    await new Promise<void>((resolve,reject)=>{ws!.once('open',resolve);ws!.once('error',reject);});
    const socketClosed=new Promise<number>(resolve=>ws!.once('close',resolve));
    await app.inject({method:'POST',url:'/v1/auth/logout',headers:account.headers});
    expect(await socketClosed).toBe(1008);
    await waitFor(()=>eventsClosed);
    eventsAbort.abort();
    await readerEvents.cancel().catch(()=>{});
    expect((await app.inject({url:path})).statusCode).toBe(401);
  }finally{eventsAbort.abort();ws?.terminate();await agent?.stop();await app.close();await desktop.close();wss.clients.forEach(socket=>socket.terminate());await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
},20000);
