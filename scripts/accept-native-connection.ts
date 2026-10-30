// Start the actual Qt application against a local synthetic Relay and an isolated Rust runtime.
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {deviceMessageSchema} from '../packages/protocol/src/index.js';
const root=resolve(import.meta.dirname,'..'), dir=join(root,'.local/native-connection',Date.now().toString());await mkdir(dir,{recursive:true});
await mkdir(join(dir,'codex'),{recursive:true});
const deviceId=randomUUID(), installationId=randomUUID();
const server=createServer((req,res)=>{
  assert.equal(req.headers.authorization,'Bearer isolated-local-session');
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify(req.url?.endsWith('/session')?{active:true}:{release:null}));
});
const ws=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>ws.handleUpgrade(req,socket,head,peer=>ws.emit('connection',peer,req)));
const messages:any[]=[];
ws.on('connection',peer=>{peer.send(JSON.stringify({type:'device.welcome',features:['files','previews','catalog','attachments']}));peer.on('message',raw=>{const message=JSON.parse(raw.toString());deviceMessageSchema.parse(message);messages.push(message);});});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert(address && typeof address==='object');
const relayUrl='http://127.0.0.1:'+address.port;
await writeFile(join(dir,'settings.json'),JSON.stringify({relayUrl,installationId,deviceName:'Native isolated connection',runtime:'headless',codexHome:join(dir,'codex'),codexBinary:'',autoConnect:true,openAtLogin:false,minimizeToTray:true,projectParents:[],allowHttp:true}));
const powershell=join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe');
const credentials=Buffer.from(JSON.stringify({relayUrl,installationId,deviceId,session:'isolated-local-session'}));
const encrypted=execFileSync(powershell,['-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))'],{input:credentials.toString('base64'),encoding:'utf8',windowsHide:true});await writeFile(join(dir,'session.native.enc'),Buffer.from(encrypted.trim(),'base64'));
const report=join(dir,'smoke.json'), app=process.env.CODEXER_QT_AGENT_EXE || join(root,'apps/agent-qt/stage/Codexer Agent.exe');
const child=spawn(app,['--smoke-test'],{env:{...process.env,CODEXER_USER_DATA_DIR:dir,CODEXER_QT_SMOKE_REPORT:report,CODEXER_QT_SMOKE_HOLD_MS:'20000'},windowsHide:true,stdio:'ignore'});
try {
  let smoke:any;
  for(let n=0;n<300;n++) {try {smoke=JSON.parse(await readFile(report,'utf8'));if(messages.some(m=>m.type==='device.catalog')) break;}catch {} if(child.exitCode!==null) throw new Error('Native app exited before connection: '+JSON.stringify({smoke,messages,directory:dir}));await new Promise(done=>setTimeout(done,100));}
  assert(smoke?.ok);assert(messages.some(m=>m.type==='device.catalog'));assert(messages.some(m=>m.type==='device.snapshot'&&m.snapshot.runtime.connected));
  await new Promise(done=>setTimeout(done,5000));
  const processList:any[]=JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',`@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,WorkingSetSize,PrivatePageCount,@{Name='createdAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}));
  const own=processList.find(p=>p.ProcessId===smoke.processId);assert.equal(own?.Name,'Codexer Agent.exe');
  const descendants=new Map<number,any>([[own.ProcessId,own]]);
  // Windows can reuse a short-lived child's PID while an older process still records it as its parent.
  for(let depth=0;depth<8;depth++) {const before=descendants.size;for(const process of processList) {const parent=descendants.get(process.ParentProcessId);if(parent&&process.createdAt>=parent.createdAt) descendants.set(process.ProcessId,process);}if(descendants.size===before) break;}
  const processes=[...descendants.values()];assert(!processes.some(p=>/node|electron|chrome/i.test(p.Name)));assert(processes.some(p=>p.Name==='codex.exe'));
  const result={ok:true,directory:dir,syntheticRelay:true,isolatedCodexHome:true,modelRequests:0,memorySampleDelayMs:5000,messages:messages.length,processes};await writeFile(join(dir,'result.json'),JSON.stringify(result,null,2));await writeFile(join(root,'.local/native-connection-latest.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  await new Promise<void>((done,fail)=>{if(child.exitCode!==null) return child.exitCode===0?done():fail(new Error('exit'));child.once('exit',code=>code===0?done():fail(new Error('exit '+code)));});
} finally {if(child.exitCode===null) child.kill();for(const peer of ws.clients) peer.terminate();ws.close();await new Promise<void>(done=>server.close(()=>done()));}
