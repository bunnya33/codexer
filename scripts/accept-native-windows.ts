import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,rm,cp,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WebSocketServer} from 'ws';
import {snapshot,waitFor} from '../tests/helpers.js';
import {snapshotSchema,catalogSchema,historyPageSchema,eventSchema,commandSchema,type RemoteThread} from '../packages/protocol/src/index.js';

// Only synthetic loopback data and isolated profiles are used. No real account,
// official Codex instance, login item or installed-client process is touched.
const native=resolve('apps/control-native');
const {version}=JSON.parse(await readFile(join(native,'package.json'),'utf8'));
const products=process.env.CODEXER_NATIVE_ACCEPTANCE_PRODUCTS||join(native,'stage');
const require=createRequire(join(native,'package.json'));
const {ClassicLevel}=require('classic-level');
const run=join(native,'stage','acceptance-'+Date.now());
const relocated=await mkdtemp(join(tmpdir(),'codexer-native-acceptance-'));
await mkdir(run,{recursive:true});
const paths:string[]=[];
const state=snapshot();
const thread=state.threads['thread-test']!;
thread.status='idle';thread.ownerAvailable=true;thread.title='原生客户端验收';thread.activeTurnId=null;
thread.settings={model:'fixture-model',modelProvider:'fixture',reasoningEffort:'high',collaborationMode:'default'};
Object.assign(state.runtime.capabilities,{modelUpdate:true,effortUpdate:true,images:true,attachments:true,collaborationModeUpdate:true});
thread.turns=[{id:'turn-5',status:'completed',items:[{id:'agent-5',type:'agentMessage',text:'Windows 原生会话已连接。\n\n```ts\nconst platform = "windows";\n```',truncated:false}],plan:[],diff:'',truncated:false}];
snapshotSchema.parse(state);
const catalog=catalogSchema.parse({protocolVersion:1,deviceId:state.deviceId,generatedAt:Date.now(),projects:[{id:'native-project',name:'原生验收项目',roots:['C:/Synthetic'],position:0,updatedAt:1}],threads:[{id:thread.id,title:thread.title,cwd:'C:/Synthetic',projectId:'native-project',updatedAt:1,archived:false,settings:thread.settings}],models:[{model:'fixture-model',displayName:'Fixture Model',supportedReasoningEfforts:['low','medium','high'],defaultReasoningEffort:'medium'}]});
const history=historyPageSchema.parse({threadId:thread.id,turns:Array.from({length:5},(_,index)=>({id:'turn-'+(5-index),status:'completed',items:[{id:'item-'+index,type:'agentMessage',text:('原生历史消息 '+(5-index)+'\n\n').repeat(20),truncated:false}],truncated:false})),nextCursor:'older-page',generatedAt:Date.now()});
const olderHistory=historyPageSchema.parse({threadId:thread.id,turns:Array.from({length:3},(_,index)=>({id:'older-'+index,status:'completed',items:[{id:'older-item-'+index,type:'agentMessage',text:('自动加载的更早消息 '+(3-index)+'\n\n').repeat(10),truncated:false}],truncated:false})),nextCursor:null,generatedAt:Date.now()});
const commands:{type:string;lines?:number}[]=[];
let sent=0;
const server=createServer(async(request,response)=>{
  const requested=new URL(request.url!,'http://localhost');
  const path=requested.pathname;paths.push(path);
  if(path.endsWith('/commands')&&request.method==='POST'){
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    const command=commandSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    commands.push({type:command.payload.type,...('text' in command.payload?{lines:command.payload.text.split(/\r\n|\r|\n/).length}:{})});
    if(command.payload.type==='turn.start'){
      const id='sent-'+(++sent),text=command.payload.text;
      const next:RemoteThread={...state.threads[thread.id]!,status:'active',activeTurnId:id,turns:[...state.threads[thread.id]!.turns,{id,status:'inProgress',items:[{id:id+'-user',type:'userMessage',text,truncated:false}],plan:[],diff:'',truncated:false}]};
      state.threads[thread.id]=next;publish();
      for(const [index,delay] of [150,450,900].entries())timers.push(setTimeout(()=>{
        const turn=next.turns.at(-1)!;
        turn.items=[turn.items[0]!,{id:id+'-agent',type:'agentMessage',text:('多行发送自动滚动验收 '+sent+'\n\n').repeat((index+1)*6)+'回复结束 '+sent,truncated:false}];
        if(index===2){next.status='idle';next.activeTurnId=null;turn.status='completed';}
        publish();
      },delay));
    }
    await writeFile(join(run,'commands.json'),JSON.stringify(commands));
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify({type:'command.result',result:{commandId:command.commandId,deviceId:state.deviceId,status:'succeeded',code:'ok'}}));return;
  }
  const value=path==='/v1/me'?{role:'user',userId:'native-fixture-user'}
    :path==='/v1/auth/active'?{expiresAt:Date.now()+604800000,idleTimeoutMinutes:10080}
    :path==='/v1/devices'?{devices:[{id:state.deviceId,name:'Native Test PC',platform:'win32',online:true}]}
    :path.endsWith('/catalog')?{catalog}
    :path.endsWith('/snapshot')?{online:true,snapshot:state}
    :path.endsWith('/turns')?(requested.searchParams.has('cursor')?olderHistory:history)
    :path.endsWith('/images')?{id:'a'.repeat(64),name:'native-preview.jpg'}
    :path==='/v1/ws/tickets'?{ticket:'synthetic-ticket-xxxxxxxxxxxxxxxxxxxxxxxx'}
    :path==='/v1/weixin'?{available:false,bound:false,connected:false,activated:false,notifications:false,replies:false,lastError:null,pendingNotifications:0}
    :path.endsWith('/weixin-notification')?{available:false,bound:false,enabled:false,allEnabled:false}
    :null;
  response.writeHead(value?200:404,{'content-type':'application/json'});response.end(JSON.stringify(value??{error:'fixture-not-found'}));
});
const sockets=new WebSocketServer({server});
function publish(){
  const event=eventSchema.parse({protocolVersion:1,deviceId:state.deviceId,epoch:state.epoch,seq:++state.lastSeq,timestamp:Date.now(),change:{type:'thread.updated',thread:state.threads[thread.id]}});
  for(const socket of sockets.clients)if(socket.readyState===1)socket.send(JSON.stringify({type:'device.event',event}));
}
let subscribed=false;
let liveScheduled=false;
const timers:ReturnType<typeof setTimeout>[]=[];
sockets.on('connection',socket=>socket.on('message',bytes=>{
  const value=JSON.parse(String(bytes));
  if(value.type==='client.authenticate')socket.send(JSON.stringify({type:'client.authenticated'}));
  if(value.type==='client.subscribe'){
    subscribed=true;
    socket.send(JSON.stringify({type:'device.snapshot',snapshot:state}));
    socket.send(JSON.stringify({type:'sync.ready',deviceId:state.deviceId,epoch:state.epoch,lastSeq:state.lastSeq}));
    if(liveScheduled)return;liveScheduled=true;
    for(const [index,delay] of [700,1500].entries())timers.push(setTimeout(()=>{
      if(socket.readyState!==1)return;
      const active=index===0;
      const next={...thread,status:active?'active' as const:'idle' as const,activeTurnId:active?'turn-5':null,queuedMessages:active?[{id:'native-queue',text:'原生队列编辑与引导',imageCount:0,createdAt:Date.now(),status:'queued' as const}]:[]};
      state.threads[thread.id]=next;state.lastSeq=index+1;
      const event=eventSchema.parse({protocolVersion:1,deviceId:state.deviceId,epoch:state.epoch,seq:index+1,timestamp:Date.now(),change:{type:'thread.updated',thread:next}});
      socket.send(JSON.stringify({type:'device.event',event}));
    },delay));
  }
}));
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
const url='http://127.0.0.1:'+((server.address() as any).port);
const children:ReturnType<typeof spawn>[]=[];
try{
  for(const mode of process.argv.includes('--control')?['control']:['control','agent']){
    const profile=join(run,mode);await mkdir(profile);
    if(mode==='control'){
      await writeFile(join(profile,'server.json'),JSON.stringify({url}));
      const db=new ClassicLevel(join(profile,'Local Storage','leveldb'),{keyEncoding:'buffer',valueEncoding:'buffer'});
      const key=Buffer.concat([Buffer.from('_'+url+'\0'),Buffer.from([1]),Buffer.from('codexer.web.relay.v1control')]);
      await db.put(key,Buffer.concat([Buffer.from([1]),Buffer.from(JSON.stringify({url,session:'synthetic-native-control-session'}))]));await db.close();
    }else{
      const installationId=randomUUID();
      await writeFile(join(profile,'settings.json'),JSON.stringify({relayUrl:url,username:'native-fixture',deviceName:'Native Test PC',installationId,codexHome:join(profile,'codex'),codexBinary:'',projectParents:[],runtime:'desktop',autoConnect:false,openAtLogin:false,minimizeToTray:true,allowHttp:false}));
      await writeFile(join(profile,'fixture.json'),JSON.stringify({relayUrl:url,username:'native-fixture',installationId,deviceId:randomUUID(),session:'synthetic-agent-session',expiresAt:8640000000000000}));
      const script=join(run,'protect.ps1');
      await writeFile(script,"param($source,$destination)\nAdd-Type -AssemblyName System.Security\n$data=[IO.File]::ReadAllBytes($source)\n[IO.File]::WriteAllBytes($destination,[Security.Cryptography.ProtectedData]::Protect($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))\n");
      const encrypted=spawnSync('powershell.exe',['-NoProfile','-File',script,join(profile,'fixture.json'),join(profile,'session.enc')],{windowsHide:true,encoding:'utf8'});
      assert.equal(encrypted.status,0,encrypted.stderr);await rm(join(profile,'fixture.json'));
    }
    const product=mode==='control'?'RelayDesk':'Codexer';
    const productDirectory=join(relocated,product);
    await cp(join(products,product+'-'+version),productDirectory,{recursive:true});
    const exe=join(productDirectory,product+'.exe');
    const child=spawn(exe,[],{env:{...process.env,CODEXER_NATIVE_MODE:mode,CODEXER_NATIVE_DATA_DIR:profile},windowsHide:true,stdio:'ignore'});children.push(child);
    await waitFor(async()=>{assert.equal(child.exitCode,null,'Native host exited during startup');return !!await readFile(join(profile,'native-startup.json')).catch(()=>null);},30000);
    const startup=JSON.parse(await readFile(join(profile,'native-startup.json'),'utf8'));
    assert.equal(startup.renderer,'react-native-windows');assert.equal(startup.mode,mode);
    if(mode==='control'){
      await waitFor(async()=>{
        assert.equal(child.exitCode,null,'Native host exited during live sync');
        const renderer=JSON.parse(await readFile(join(profile,'native-renderer-state.json'),'utf8').catch(()=>'{}'));
        return subscribed&&paths.some(path=>path.endsWith('/turns'))&&renderer.snapshots?.[0]?.seq===2&&renderer.histories?.[0]?.count===5&&!renderer.histories[0].loading;
      },30000);
      const encrypted=await readFile(join(profile,'control-session.native.enc'));
      assert.ok(!encrypted.includes(Buffer.from('synthetic-native-control-session')));
    }else{
      await waitFor(async()=>!!await readFile(join(profile,'session.native.enc')).catch(()=>null),10000);
    }
    const log=await readFile(join(profile,'native-renderer.log'),'utf8');
    assert.doesNotMatch(log,/TypeError|ReferenceError|renderer-failed|isComponentError/);
    console.log(JSON.stringify({mode,pid:child.pid,profile,startup,nativeCredentialMigration:true,serverConnected:mode==='control'?subscribed:undefined}));
  }
  // Keep the isolated windows available for manual UI acceptance when requested.
  const keep=process.argv.includes('--keep');
  await writeFile(join(run,'report.json'),JSON.stringify({ok:true,paths,profiles:children.map((child,index)=>({mode:index?'agent':'control',pid:child.pid}))},null,2));
  console.log(JSON.stringify({ok:true,run,paths}));
  if(keep)await new Promise<void>(done=>{process.once('SIGINT',done);process.once('SIGTERM',done);});
}catch(error){
  console.error(JSON.stringify({ok:false,run,paths,subscribed,liveScheduled}));
  throw error;
}finally{
  for(const timer of timers)clearTimeout(timer);
  for(const child of children)child.kill();
  for(const socket of sockets.clients)socket.terminate();sockets.close();
  await new Promise<void>(done=>server.close(()=>done()));
  // Windows may retain image sections briefly after the host process exits.
  await rm(relocated,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
