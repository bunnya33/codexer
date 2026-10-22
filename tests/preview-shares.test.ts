import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket,WebSocketServer} from 'ws';
import {expect,it} from 'vitest';
import {PcAgent} from '../apps/pc-agent/src/agent';
import {createRelay,RelayStore} from './go-relay';
import {testAccount,testAgent} from './account-helpers';
import {FakeDesktop,waitFor} from './helpers';

it('shares live pages and HTML with stable keys, independent guests, revocation, reconnect and server restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'codexer-share-')),htmlPath=join(directory,'shared.html');
  await writeFile(htmlPath,'<html><head></head><body><h1>共享页面第一版</h1></body></html>');
  const upstream=createServer(async(req,res)=>{
    if(req.url==='/cookie'){res.setHeader('set-cookie','visitor=first; Path=/');res.end('cookie-set');}
    else if(req.url==='/api'){res.setHeader('content-type','application/json');res.end(JSON.stringify({cookie:req.headers.cookie??'',authorization:req.headers.authorization??''}));}
    else if(req.url==='/src/main.js'){res.setHeader('content-type','application/javascript');res.end('import "/src/other.js";');}
    else if(req.url==='/logo.svg'){res.setHeader('content-type','image/svg+xml');res.end('<svg/>');}
    else{res.setHeader('content-type','text/html');res.end('<html><head></head><body><h1>共享端口</h1><script src="/src/main.js"></script><img src="/logo.svg"></body></html>');}
  });
  const sockets=new WebSocketServer({server:upstream});sockets.on('connection',ws=>ws.on('message',bytes=>ws.send(bytes)));
  await new Promise<void>(done=>upstream.listen(0,'127.0.0.1',done));
  const port=(upstream.address() as {port:number}).port,source=`http://localhost:${port}/demo?x=1`;
  let store=await RelayStore.open(undefined,join(directory,'db'));
  const account=await testAccount(store),other=await testAccount(store,'Other');
  const registered=await testAgent(store,account.id),desktop=new FakeDesktop();
  const turns=desktop.state.turnHistory as {history:{entitiesByKey:Record<string,{items:unknown[]}>}};
  turns.history.entitiesByKey['turn-key']!.items=[{id:'preview',type:'agentMessage',text:`[端口](${source})\n[页面](<${htmlPath}>)`}];
  let app=await createRelay({store,heartbeatMs:50}),agent:PcAgent|undefined,ws:WebSocket|undefined;
  try{
    await desktop.start();const base=await app.listen({host:'127.0.0.1',port:0});
    const reader={list:async()=>({protocolVersion:1 as const,deviceId:registered.id,generatedAt:Date.now(),projects:[],threads:[{id:'thread-test',title:'Shared page',cwd:null,projectId:null,updatedAt:1,archived:false}]}),history:async()=>({threadId:'thread-test',generatedAt:Date.now(),nextCursor:null,turns:[]})};
    agent=new PcAgent({relayUrl:base,deviceId:registered.id,session:registered.token,installationId:'fixture',username:account.name,expiresAt:Date.now()+600000},directory,['thread-test'],desktop.endpoint,join(directory,'empty'),'desktop',reader);
    await agent.start();await waitFor(async()=>!!(await store.catalog(registered.id))&&!!(await store.snapshot(registered.id))?.threads['thread-test']?.turns[0]?.items.length);
    const endpoint=`/v1/devices/${registered.id}/threads/thread-test/preview-shares`;
    const create=(kind='server',page=source,rotate=false)=>app.inject({method:'POST',url:endpoint,headers:account.headers,payload:{kind,source:page,rotate}});
    const frame=async(path:string)=>{const response=await app.inject({url:path});expect(response.statusCode).toBe(200);expect(response.body).toContain('sandbox="allow-scripts allow-forms"');expect(response.body).not.toContain('allow-same-origin');return response.body.match(/<iframe[^>]+src="([^"]+)"/)![1]!.replaceAll('&amp;','&');};
    const initial=await create();expect(initial.statusCode).toBe(200);const share=initial.json();
    expect(share.path).toMatch(/^\/share\/[a-f0-9]{64}$/);
    expect((await create()).json()).toEqual(share);
    expect((await create('server',source.replace('localhost','127.0.0.1'))).json().path).toBe(share.path);
    expect((await create('server',source+'#section')).json().path).toBe(share.path);
    expect((await create('server',`http://localhost:${port}/other`)).json().path).not.toBe(share.path);
    const status=await app.inject({url:endpoint+'?'+new URLSearchParams({kind:'server',source}),headers:account.headers});expect(status.json().share).toEqual(share);
    expect((await app.inject({method:'POST',url:endpoint,headers:other.headers,payload:{kind:'server',source}})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:endpoint,payload:{kind:'server',source}})).statusCode).toBe(401);
    for(const value of ['http://192.168.1.2/','http://localhost.evil/','http://u:p@localhost/','file:///secret'])expect((await create('server',value)).statusCode).toBe(400);
    expect((await create('server','http://localhost:1/')).statusCode).toBe(404);
    const first=await frame(share.path),second=await frame(share.path),prefix=first.replace(/demo\?x=1$/,'');
    expect(first).not.toBe(second);
    const visitor=await app.inject({url:share.path});
    const guestCookie=String(visitor.headers['set-cookie']).split(';')[0]!;
    const reload=await app.inject({url:share.path+'/',headers:{cookie:guestCookie}});
    expect(reload.statusCode).toBe(200);expect(reload.body).toBe(visitor.body);
    const html=await app.inject({url:first});expect(html.statusCode).toBe(200);expect(html.body).toContain(prefix+'src/main.js');expect(html.body).toContain('共享端口');
    expect((await app.inject({url:prefix+'src/main.js'})).body).toContain(prefix+'src/other.js');
    expect((await app.inject({url:prefix+'logo.svg'})).body).toBe('<svg/>');
    await app.inject({url:prefix+'cookie'});
    expect((await app.inject({url:prefix+'api',headers:account.headers})).json()).toEqual({cookie:'visitor=first',authorization:''});
    expect((await app.inject({url:second.replace(/demo\?x=1$/,'api')})).json()).toEqual({cookie:'',authorization:''});
    ws=new WebSocket(base.replace(/^http/,'ws')+prefix+'__socket?path=%2F');
    const echo=new Promise<string>((done,fail)=>{ws!.once('open',()=>ws!.send('shared-hmr'));ws!.once('message',data=>done(data.toString()));ws!.once('error',fail);});expect(await echo).toBe('shared-hmr');
    // Closing the creating login session must not revoke public guests.
    await app.inject({method:'POST',url:'/v1/auth/logout',headers:account.headers});
    await new Promise(done=>setTimeout(done,120));expect(ws.readyState).toBe(WebSocket.OPEN);
    expect((await app.inject({url:first})).statusCode).toBe(200);
    const renewed=await store.createSession(account.id);account.headers.authorization=`Bearer ${renewed.session}`;
    const closed=new Promise<number>(done=>ws!.once('close',done));
    expect((await app.inject({method:'DELETE',url:`/v1/devices/${registered.id}/preview-shares/${share.id}`,headers:other.headers})).statusCode).toBe(404);
    expect((await app.inject({method:'DELETE',url:`/v1/devices/${registered.id}/preview-shares/${share.id}`,headers:account.headers})).statusCode).toBe(200);
    expect(await closed).toBe(1008);expect((await app.inject({url:share.path})).statusCode).toBe(410);expect((await app.inject({url:first})).statusCode).toBe(410);
    expect((await create()).json().path).toBe(share.path);
    const rotated=(await create('server',source,true)).json();expect(rotated.path).not.toBe(share.path);expect((await app.inject({url:share.path})).statusCode).toBe(410);
    const htmlShare=await create('html',htmlPath);expect(htmlShare.statusCode).toBe(200);const fileFrame=await frame(htmlShare.json().path);
    expect((await app.inject({url:fileFrame})).body).toContain('共享页面第一版');
    await writeFile(htmlPath,'<h1>共享页面第二版</h1>');expect((await app.inject({url:fileFrame})).body).toContain('共享页面第二版');
    expect((await app.inject({url:fileFrame.replace('index.html','private.txt')})).statusCode).toBe(404);
    expect((await create('html',join(directory,'unreferenced.html'))).statusCode).toBe(404);
    const restoredFrame=await frame(rotated.path);
    await new Promise<void>(done=>upstream.close(()=>done()));
    const unavailable=await app.inject({url:restoredFrame,headers:{accept:'text/html'}});expect(unavailable.statusCode).toBe(502);expect(unavailable.body).toContain('网页暂不可用');
    await new Promise<void>(done=>upstream.listen(port,'127.0.0.1',done));expect((await app.inject({url:restoredFrame})).statusCode).toBe(200);
    agent.disconnect();await waitFor(async()=>!(await app.inject({url:'/v1/devices',headers:account.headers})).json().devices[0].online);
    const offline=await app.inject({url:rotated.path});expect(offline.statusCode).toBe(503);expect(offline.body).toContain('电脑暂时离线');
    agent.reconnect();await waitFor(()=>!!agent!.status().relayConnected);await frame(rotated.path);
    // Restart the relay itself on the same address and persist database keys.
    await app.close();store=await RelayStore.open(undefined,join(directory,'db'));app=await createRelay({store});await app.listen({host:'127.0.0.1',port:Number(new URL(base).port)});
    agent.reconnect();await waitFor(async()=>!!agent!.status().relayConnected&&(await app.inject({url:rotated.path})).statusCode===200,10000);
    expect((await create()).json().path).toBe(rotated.path);
  }finally{ws?.terminate();await agent?.stop();await app.close();await desktop.close();for(const socket of sockets.clients)socket.terminate();await new Promise<void>(done=>sockets.close(()=>done()));await new Promise<void>(done=>upstream.close(()=>done()));await rm(directory,{recursive:true,force:true});}
},30000);
