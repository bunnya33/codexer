// Normal idle startup, without smoke screenshots, account login or working-set trimming.
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
if(process.platform!=='win32')throw new Error('Windows memory metrics require Windows');
const root=resolve(import.meta.dirname,'..');
const directory=join(root,'.local/qt-agent-memory',Date.now().toString());await mkdir(directory,{recursive:true});
const executable=process.env.CODEXER_QT_AGENT_EXE||join(root,'apps/agent-qt/stage/Codexer Agent.exe');
const powershell=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const results=[];
const sample=pid=>JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-File',join(root,'scripts/measure-qt-memory.ps1'),'-AgentProcessId',String(pid)],{encoding:'utf8',windowsHide:true}));
for(const mode of ['visible','background']) {
  const profile=join(directory,mode);await mkdir(profile);
  await writeFile(join(profile,'settings.json'),JSON.stringify({relayUrl:'https://relay.example.test',installationId:randomUUID(),username:'',deviceName:'Memory acceptance',autoConnect:false,openAtLogin:false,minimizeToTray:true,runtime:'auto',projectParents:[],allowHttp:false}));
  const env={...process.env,CODEXER_USER_DATA_DIR:profile};
  const child=spawn(executable,mode==='background'?['--background']:[],{env,stdio:'ignore',windowsHide:true});
  try {
    let previous=0;const samples=[];
    for(const seconds of [5,30]) {
      await new Promise(done=>setTimeout(done,(seconds-previous)*1000));previous=seconds;
      assert.equal(child.exitCode,null);const memory=sample(child.pid);samples.push({seconds,...memory});
      console.log(JSON.stringify({mode,seconds,workingSetMiB:Math.round(memory.workingSetBytes/1048576*10)/10,privateCommitMiB:Math.round(memory.privateCommitBytes/1048576*10)/10}));
    }
    let restore;
    if(mode==='background') {
      const second=spawn(executable,['--background'],{env,stdio:'ignore',windowsHide:true});assert.equal(await new Promise(done=>second.once('exit',done)),0);
      await new Promise(done=>setTimeout(done,2000));assert.equal(child.exitCode,null);
      const handle=execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${child.pid}).MainWindowHandle.ToInt64()`],{encoding:'utf8',windowsHide:true}).trim();assert.notEqual(handle,'0');restore={sameProcess:true,windowVisible:true,memory:sample(child.pid)};
    }
    results.push({mode,samples,restore});
  } finally {if(child.exitCode===null){const exit=new Promise(done=>child.once('exit',done));child.kill();await exit;}}
}
const report={executable,executableSha256:createHash('sha256').update(await readFile(executable)).digest('hex'),screenshots:false,credentials:false,modelRequests:0,relayConnections:0,workingSetTrimmed:false,results};
await writeFile(join(directory,'results.json'),JSON.stringify(report,null,2)+'\n');
await writeFile(join(root,'.local/qt-agent-memory-latest.json'),JSON.stringify({directory,...report},null,2)+'\n');
console.log('Memory acceptance: '+directory);
