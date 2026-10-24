import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Start the real packaged native hosts with synthetic, isolated profiles. This
// checks the renderer/bridge/service together without an account or login item.
if(process.platform!=='darwin')throw new Error('Native macOS startup acceptance requires macOS.');
const root=resolve(import.meta.dirname,'..');
const {version}=JSON.parse(await readFile(join(root,'apps/control-native/package.json'),'utf8'));
const products=process.env.CODEXER_NATIVE_ACCEPTANCE_PRODUCTS||join(root,'apps/control-native/stage');
const results=[];
for(const mode of ['control']){
  const name='Codexer Control';
  const app=join(products,`${name}-${version}-macos-${process.arch}`,`${name}.app`);
  const executable=join(app,'Contents/MacOS',name);
  await access(executable);
  const directory=await mkdtemp(join(tmpdir(),`codexer-native-${mode}-`));
  let child,logs='';
  try{
    if(mode==='agent')await writeFile(join(directory,'settings.json'),JSON.stringify({relayUrl:'http://127.0.0.1:9',username:'native-fixture',deviceName:'Native Mac acceptance',installationId:randomUUID(),codexHome:join(directory,'codex'),codexBinary:'',projectParents:[],runtime:'auto',autoConnect:false,openAtLogin:false,minimizeToTray:true,allowHttp:true}));
    const env={...process.env,CODEXER_NATIVE_DATA_DIR:directory,CODEXER_NATIVE_MODE:mode};
    child=spawn(executable,[],{env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>{logs=(logs+chunk).slice(-16000);});
    child.stderr.on('data',chunk=>{logs=(logs+chunk).slice(-16000);});
    let spawnError;child.on('error',error=>{spawnError=error;});
    let startup;
    const deadline=Date.now()+45000;
    while(Date.now()<deadline){
      if(spawnError)throw spawnError;
      assert.equal(child.exitCode,null,`${name} exited before startup: ${logs}`);
      assert.equal(child.signalCode,null,`${name} crashed before startup: ${logs}`);
      try{startup=JSON.parse(await readFile(join(directory,'native-startup.json'),'utf8'));break;}catch{}
      await delay(200);
    }
    assert.ok(startup,`${name} native renderer did not start: ${logs}`);
    assert.equal(startup.version,version);assert.equal(startup.mode,mode);
    assert.equal(startup.renderer,'react-native-macos');
    assert.equal(startup.screen,mode==='agent'?'agent-management':'conversation');
    await delay(1500);
    assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
    const errorFile=join(directory,'native-'+createHash('sha256').update('renderer-error').digest('hex')+'.json');
    assert.equal(await access(errorFile).then(()=>true,()=>false),false,'Renderer error boundary was triggered.');
    const duplicate=spawn(executable,[],{env,stdio:'ignore'});
    const duplicateExit=await Promise.race([new Promise((done,fail)=>{duplicate.once('error',fail);duplicate.once('exit',code=>done(code));}),delay(5000).then(()=>{duplicate.kill('SIGTERM');throw new Error('Duplicate native instance did not exit.');})]);
    assert.equal(duplicateExit,0);assert.equal(child.exitCode,null);
    results.push({name,version,mode,renderer:startup.renderer,screen:startup.screen,duplicateInstanceRejected:true});
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){
      const exited=new Promise(done=>child.once('exit',done));child.kill('SIGTERM');
      await Promise.race([exited,delay(7000)]);
      if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}
    }
    await rm(directory,{recursive:true,force:true});
  }
}
console.log(JSON.stringify({nativeMacStartup:results},null,2));
