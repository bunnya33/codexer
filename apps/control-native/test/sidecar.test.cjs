const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const {mkdtemp,mkdir,writeFile,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {randomUUID}=require('node:crypto');
const {ClassicLevel}=require('classic-level');
const envelope=value=>Buffer.from('test-envelope:'+value).map(byte=>byte^0xa5).toString('base64');
async function harness(directory,mode='control',extra={}){
  const child=spawn(process.execPath,[process.env.CODEXER_NATIVE_SERVICE || resolve(__dirname,'../service/sidecar.cjs')],{env:{...process.env,CODEXER_NATIVE_MODE:mode,CODEXER_NATIVE_DATA_DIR:directory},stdio:['pipe','pipe','pipe']});
  let sequence=0;const pending=new Map();let stderr='';child.stderr.on('data',bytes=>stderr+=bytes.toString());
  const operations={protect:value=>envelope(Buffer.from(value.value,'base64').toString()),unprotect:value=>{const raw=Buffer.from(value.value,'base64').map(byte=>byte^0xa5).toString();if(!raw.startsWith('test-envelope:'))throw new Error('decrypt-failed');return Buffer.from(raw.slice(14)).toString('base64');},loginItem:()=>true,...extra};
  createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);if(value.nativeId){Promise.resolve().then(()=>{if(!operations[value.method])throw new Error('unsupported-test-operation');return operations[value.method](value.value);}).then(result=>child.stdin.write(JSON.stringify({nativeId:value.nativeId,value:result})+'\n'),error=>child.stdin.write(JSON.stringify({nativeId:value.nativeId,error:error.message})+'\n'));}else if(value.id){const entry=pending.get(value.id);if(entry){pending.delete(value.id);value.error?entry.reject(new Error(value.error)):entry.resolve(value.value);}}});
  child.on('exit',()=>{for(const entry of pending.values())entry.reject(new Error('service-stopped:'+stderr));pending.clear();});
  return {call:(method,value={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,value})+'\n');}),stop:async()=>{child.stdin.end();if(child.exitCode===null)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(()=>{child.kill();resolve();},2000))]);}};
}
test('persists close behavior and concurrent storage writes through native IPC',{timeout:15000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-control-test-'));let app;
  try{app=await harness(directory);assert.equal((await app.call('preferences.read')).closeExits,false);await app.call('preferences.save',{closeExits:true});await Promise.all(Array.from({length:20},(_,i)=>app.call('storage.write',{key:'shared',value:{i}})));assert.equal((await app.call('storage.read',{key:'shared'})).i,19);await app.stop();app=await harness(directory);assert.equal((await app.call('preferences.read')).closeExits,true);await assert.rejects(app.call('readChunk',{path:join(directory,'private'),position:0,length:3}),/invalid-file-read/);}finally{await app?.stop();await rm(directory,{recursive:true,force:true});}
});
test('migrates the current Chromium credential value and never restores it after logout',{timeout:15000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-migration-test-'));let app;
  try{await writeFile(join(directory,'server.json'),JSON.stringify({url:'https://relay.example.test'}));const path=join(directory,'Local Storage','leveldb');await mkdir(path,{recursive:true});const db=new ClassicLevel(path,{keyEncoding:'buffer',valueEncoding:'buffer'});const key=Buffer.concat([Buffer.from('_https://relay.example.test\0'),Buffer.from([1]),Buffer.from('codexer.web.relay.v1control')]);await db.put(key,Buffer.concat([Buffer.from([1]),Buffer.from(JSON.stringify({url:'https://relay.example.test',session:'synthetic-session'}))]));await db.close();app=await harness(directory);assert.deepEqual(await app.call('credentials.read'),{url:'https://relay.example.test',session:'synthetic-session'});assert.ok(!(await readFile(join(directory,'control-session.native.enc'))).includes(Buffer.from('synthetic-session')));await app.call('credentials.clear');assert.equal(await app.call('credentials.read'),null);const original=new ClassicLevel(path,{keyEncoding:'buffer',valueEncoding:'buffer'});assert.ok(await original.get(key));await original.close();}finally{await app?.stop();await rm(directory,{recursive:true,force:true});}
});
test('keeps the agent installation identity and restores an encrypted indefinite login',{timeout:15000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-agent-test-'));let app;
  try{const installationId=randomUUID();const settings={relayUrl:'https://relay.example.test',username:'synthetic',deviceName:'Native Test PC',installationId,codexHome:join(directory,'codex'),codexBinary:'',projectParents:[],runtime:'auto',autoConnect:false,openAtLogin:false,minimizeToTray:true,allowHttp:false};await writeFile(join(directory,'settings.json'),JSON.stringify(settings));const credentials={relayUrl:settings.relayUrl,username:settings.username,installationId,deviceId:randomUUID(),session:'synthetic-agent-session',expiresAt:8640000000000000};await writeFile(join(directory,'session.enc'),Buffer.from(envelope(JSON.stringify(credentials)),'base64'));app=await harness(directory,'agent');const state=await app.call('agent.state');assert.equal(state.loggedIn,true);assert.equal(state.settings.installationId,installationId);assert.equal(state.expiresAt,8640000000000000);assert.equal(state.phase,'disconnected');assert.ok(!JSON.stringify(state).includes(credentials.session));await app.call('agent.save',{...state.settings,minimizeToTray:false});assert.equal((await app.call('agent.state')).settings.installationId,installationId);assert.equal(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')).minimizeToTray,false);}finally{await app?.stop();await rm(directory,{recursive:true,force:true});}
});

test('reports the common build version and host platform after native renderer startup',{timeout:15000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-startup-test-'));let app;
  try{app=await harness(directory);await app.call('ready',{screen:'conversation'});const startup=JSON.parse(await readFile(join(directory,'native-startup.json'),'utf8'));assert.equal(startup.version,require('../package.json').version);assert.equal(startup.renderer,process.platform==='darwin'?'react-native-macos':'react-native-windows');assert.equal(startup.screen,'conversation');}finally{await app?.stop();await rm(directory,{recursive:true,force:true});}
});
test('preserves selected attachment paths containing spaces, unicode, and URL fragments',{timeout:15000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-files-test-'));let app;
  try{const path=join(directory,'音乐 #1 %.txt');await writeFile(path,'synthetic attachment');app=await harness(directory,'control',{pick:()=>[path]});const [picked]=await app.call('pick',{kind:'files'});assert.equal(picked.uri,require('node:url').pathToFileURL(path).href);assert.equal(Buffer.from(await app.call('readChunk',{path,position:0,length:1024}),'base64').toString(),'synthetic attachment');}finally{await app?.stop();await rm(directory,{recursive:true,force:true});}
});
