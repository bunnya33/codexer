import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const root=resolve(import.meta.dirname,'..'),app=join(root,'apps/desktop');
const {version}=JSON.parse(await readFile(join(app,'package.json'),'utf8'));
const executable=process.env.CODEXER_AGENT_ACCEPTANCE_EXE||(process.platform==='darwin'?join(app,'release/mac-arm64/Codexer Agent.app/Contents/MacOS/Codexer Agent'):join(app,'release/win-unpacked/Codexer Agent.exe'));
await access(executable);
const directory=await mkdtemp(join(tmpdir(),'codexer-electron-agent-'));
const installationId=randomUUID();
let child;
try{
  await writeFile(join(directory,'settings.json'),JSON.stringify({relayUrl:'http://127.0.0.1:9',username:'synthetic-account',deviceName:'Electron Agent acceptance',installationId,codexHome:join(directory,'codex'),codexBinary:'',projectParents:[],runtime:'auto',autoConnect:false,openAtLogin:false,minimizeToTray:true,allowHttp:true}));
  child=spawn(executable,[],{env:{...process.env,CODEXER_USER_DATA_DIR:directory},stdio:'ignore'});
  let ready=false;const deadline=Date.now()+30000;
  while(Date.now()<deadline){assert.equal(child.exitCode,null,'Agent exited during startup');assert.equal(child.signalCode,null,'Agent crashed during startup');try{const logs=await readFile(join(directory,'diagnostics.log'),'utf8');if(logs.includes('console-ready')){ready=true;break;}}catch{}await delay(200);}
  assert.ok(ready,'Electron Agent did not initialize');
  const settings=JSON.parse(await readFile(join(directory,'settings.json'),'utf8'));assert.equal(settings.installationId,installationId);assert.equal(settings.deviceName,'Electron Agent acceptance');
  const duplicate=spawn(executable,[],{env:{...process.env,CODEXER_USER_DATA_DIR:directory},stdio:'ignore'});
  const code=await Promise.race([new Promise((done,fail)=>{duplicate.once('error',fail);duplicate.once('exit',done);}),delay(5000).then(()=>{duplicate.kill();throw new Error('Duplicate Agent did not exit');})]);assert.equal(code,0);
  const report={name:'Codexer Agent',version,runtime:'Electron',platform:process.platform,architecture:process.arch,startup:true,profilePreserved:true,duplicateInstanceRejected:true};
  await writeFile(join(app,'release/agent-acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{
  if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(done=>child.once('exit',done));child.kill('SIGTERM');await Promise.race([exited,delay(5000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  await rm(directory,{recursive:true,force:true});
}
