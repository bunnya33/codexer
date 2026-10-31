// Cross-language contract checks: the shipped C++ backend must obey the shared Zod protocol.
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import assert from 'node:assert/strict';
import {commandSchema, threadSchema, historyPageSchema} from '../packages/protocol/src/index.js';
import {normalizeThread, normalizeHistoryTurn} from '../packages/codex-adapter/src/normalize.js';
import {mcpApproval} from '../packages/codex-adapter/src/mcp-approvals.js';
const root=resolve(import.meta.dirname,'..');
const dir=join(root,'.local/native-protocol'); await mkdir(dir,{recursive:true});
const jobs: {kind:string; value:any}[]=[];
const add=(kind:string,value:any)=>jobs.push({kind,value});
const envelope={commandId:'command',deviceId:'device',expectedEpoch:'epoch',expiresAt:Date.now()+60000};
const payloads: Record<string,any>[]=[
 {type:'runtime.refresh'}, {type:'project.create',parentId:'parent',name:'Sample',relativePath:'sample',mode:'new'},
 {type:'project.delete.prepare',projectId:'project'}, {type:'project.delete',projectId:'project',token:'e3020b32-b184-4eef-a636-b6c80360df39',deleteDirectory:true},
 {type:'thread.create',projectId:'project'}, ...['thread.watch','thread.archive','thread.delete'].map(type=>({type,threadId:'thread'})),
 {type:'thread.rename',threadId:'thread',name:'Rename'},
 ...['turn.start','turn.steer','turn.queue'].map(type=>({type,threadId:'thread',turnId:'turn',text:'你好',images:['a'.repeat(64)],attachments:['b'.repeat(64)]})),
 ...['turn.queue.read','turn.queue.remove','turn.queue.steer'].map(type=>({type,threadId:'thread',turnId:'turn',queueId:'queue'})),
 {type:'turn.queue.update',threadId:'thread',queueId:'queue',text:'new',expectedText:'old'},
 {type:'turn.interrupt',threadId:'thread',turnId:'turn'},
 {type:'thread.model.update',threadId:'thread',model:'model',expectedModel:'old'},
 {type:'thread.effort.update',threadId:'thread',effort:'high',expectedModel:'model',expectedEffort:null},
 {type:'thread.mode.update',threadId:'thread',mode:'plan',expectedMode:null,expectedModel:'model',expectedEffort:null},
 {type:'thread.permissions.update',threadId:'thread',mode:'ask',expectedPermissions:'f'.repeat(64)},
 {type:'approval.respond',threadId:'thread',turnId:'turn',requestId:'req',decision:'accept'},
 {type:'elicitation.respond',threadId:'thread',turnId:null,requestId:'req',decision:'accept',scope:'session'},
 {type:'input.respond',threadId:'thread',turnId:'turn',requestId:'req',answers:{question:{answers:['answer']}}},
];
for(const payload of payloads) {
 add('command',{...envelope,payload});
 for(const key of Object.keys(payload)) {
   const missing={...payload}; delete missing[key]; add('command',{...envelope,payload:missing});
   add('command',{...envelope,payload:{...payload,[key]:123}});
 }
}
for(const expiresAt of [null,1.2,'tomorrow',Number.MAX_VALUE]) add('command',{...envelope,expiresAt,payload:{type:'runtime.refresh'}});
const items=[
 {id:'user',type:'userMessage',content:[{type:'text',text:'Please fix this'}]},
 {id:'reason',type:'reasoning',summary:['First','Second']},
 {id:'cmd',type:'commandExecution',command:'Get-Location',aggregatedOutput:'C:/sandbox',status:'completed'},
 {id:'file',type:'fileChange',status:'completed',changes:[{path:'hello.cpp',kind:{type:'update'},diff:'@@ -1 +1 @@\n-old\n+new'}]},
 {id:'agent',type:'agentMessage',phase:'final_answer',text:'Finished'},
];
const turn={id:'turn',turnId:'turn',status:'completed',startedAt:100,completedAt:102,items,itemTimingsById:{cmd:{startedAtMs:100200,completedAtMs:100500}}};
const base={id:'thread-test',title:'Contract',cwd:'C:/sandbox',threadRuntimeStatus:{type:'idle'},turns:[turn],requests:[],updatedAt:102000};
add('thread',base); add('history',turn);
for(const identity of [{},{turnId:null},{turnId:''},{id:''},{turnId:'',id:'fallback'},{turnId:'current',id:'legacy'},{turnId:'x'.repeat(161)},{turnId:123,id:'fallback'}]) {
  add('thread',{...base,threadRuntimeStatus:{type:'active'},turns:[{id:'previous',status:'inProgress',items:[]},{...identity,status:'inProgress',items:[]}]});
}
for(const turnId of ['',null,'x'.repeat(161)]) add('thread',{...base,requests:[{id:'request',method:'mcpServer/elicitation/request',params:{turnId}}]});
add('thread',{...base,turns:[{...turn,status:'inProgress',items:[...items,{id:'q',type:'agentMessage',questions:[{title:'Pick',options:['A','B']}]}]}],threadRuntimeStatus:{type:'active'}});
add('thread',{...base,requests:[{id:1,method:'item/commandExecution/requestApproval',params:{threadId:'thread-test',turnId:'turn',command:'dir',availableDecisions:['accept','decline']}}]});
add('thread',{...base,turns:[{...turn,items:[{id:'spawn',type:'collabAgentToolCall',tool:'spawnAgent',senderThreadId:'thread-test',receiverThreadIds:['child'],agentsStates:{child:{status:'running'}},prompt:'Task',model:'model'},{id:'done',type:'collabAgentToolCall',tool:'wait',receiverThreadIds:['child'],agentsStates:{child:{status:'completed',message:'Done'}}}]}]});
for(const text of [
 'Files mentioned by the user:\nreport.txt: /tmp/report.txt\n\nMy request:\nReview this file',
 '<in-app-browser-context source="ambient-ui-state">hidden</in-app-browser-context>My request: hello',
 'Before <send_user_message_question_reply>[{"questionItemId":"q","question":"Pick?","answer":"A"}]</send_user_message_question_reply> after',
]) add('thread',{...base,turns:[{...turn,items:[{id:'u',type:'userMessage',content:[{type:'text',text}]}]}]});
for(const value of [
 {mode:'form',serverName:'browser',requestedSchema:{type:'object',properties:{}},_meta:{origin:'https://example.test/path',persist:['session']}},
 {mode:'form',serverName:'other',requestedSchema:{type:'object',properties:{}},_meta:{origin:'https://example.test'}},
 {mode:'form',serverName:'browser',requestedSchema:{type:'object',properties:{password:{type:'string'}}},_meta:{origin:'https://example.test'}},
]) add('approval',value);
await writeFile(join(dir,'input.json'),JSON.stringify(jobs));
const sdk=process.env.CODEXER_QT_ROOT || process.env.QT_ROOT_DIR || join(root,'.local/qt/6.8.3/msvc2022_64');
execFileSync(join(root,'apps/agent-qt/build/Release/CodexerNativeTests.exe'),['--protocol-fixtures',join(dir,'input.json'),join(dir,'output.json')],{env:{...process.env,PATH:join(sdk,'bin')+';'+process.env.PATH},windowsHide:true});
const results=JSON.parse(await readFile(join(dir,'output.json'),'utf8'));
assert.equal(results.length,jobs.length);
for(let i=0;i<jobs.length;i++) {
 const {kind,value}=jobs[i]!, actual=results[i];
 if(kind==='command') assert.equal(actual,commandSchema.safeParse(value).success,JSON.stringify(value));
 if(kind==='thread') {
   threadSchema.parse(actual);
   const expected=normalizeThread(value,0);
   assert.equal(actual.status,expected.status); assert.equal(actual.activeTurnId,expected.activeTurnId);
   assert.deepEqual(actual.turns.map((t:any)=>t.items.map((item:any)=>[item.id,item.text,item.command,item.output,item.startedAtMs,item.completedAtMs])),expected.turns.map(t=>t.items.map(item=>[item.id,item.text,item.command,item.output,item.startedAtMs,item.completedAtMs])));
   assert.deepEqual(actual.requests,expected.requests);
   assert.deepEqual(actual.subAgents.map((a:any)=>[a.threadId,a.status,a.message]),expected.subAgents?.map(a=>[a.threadId,a.status,a.message]));
 }
 if(kind==='history') {
   historyPageSchema.parse({threadId:'thread-test',turns:[actual],nextCursor:null,generatedAt:Date.now()});
   const expected=normalizeHistoryTurn(value,undefined,'thread-test');
   assert.equal(actual.startedAtMs,expected.startedAtMs); assert.equal(actual.completedAtMs,expected.completedAtMs);
 }
 if(kind==='approval') assert.deepEqual(actual,mcpApproval(value) ?? {});
}
await writeFile(join(dir,'result.json'),JSON.stringify({cases:jobs.length,passed:true},null,2));
console.log(`Native protocol contract: ${jobs.length} cases passed`);
