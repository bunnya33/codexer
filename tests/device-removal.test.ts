import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {PcAgent} from '../apps/pc-agent/src/agent';
import {createRelay,RelayStore} from './go-relay';
import {testAccount,testAgent} from './account-helpers';
import {FakeDesktop,waitFor,WsPeer} from './helpers';

it('removes offline data across restart and lets an unchanged PC Agent restore itself with its saved session',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'codexer-remove-device-')),db=join(directory,'db'),desktop=new FakeDesktop();
  let store=await RelayStore.open(undefined,db),app=await createRelay({store}),agent:PcAgent|undefined,client:WsPeer|undefined;
  const account=await testAccount(store),other=await testAccount(store,'Other'),registered=await testAgent(store,account.id);
  try{
    const path=join(directory,'local.txt');await writeFile(path,'preserve local file');
    await desktop.start();let base=await app.listen({port:0});
    const credentials={relayUrl:base,deviceId:registered.id,session:registered.token,installationId:'fixture',username:account.name,expiresAt:Date.now()+600000};
    const reader={list:async()=>({protocolVersion:1 as const,deviceId:registered.id,generatedAt:Date.now(),projects:[],threads:[{id:'thread-test',title:'Fixture',cwd:null,projectId:null,updatedAt:1,archived:false}]}),history:async()=>({threadId:'thread-test',generatedAt:Date.now(),nextCursor:null,turns:[]})};
    agent=new PcAgent(credentials,directory,['thread-test'],desktop.endpoint,join(directory,'empty'),'desktop',reader);
    await agent.start();await waitFor(async()=>!!await store.snapshot(registered.id)&&!!await store.catalog(registered.id));
    const ticket=await store.ticket((await store.sessionPrincipal(account.session))!);
    client=await WsPeer.open(base.replace('http','ws')+'/v1/ws/client');client.send({type:'client.authenticate',ticket:ticket.ticket});await client.wait(m=>m.type==='client.authenticated');
    const remove=()=>app.inject({method:'DELETE',url:`/v1/devices/${registered.id}/data`,headers:account.headers});
    expect((await app.inject({method:'DELETE',url:`/v1/devices/${registered.id}/data`,headers:other.headers})).statusCode).toBe(404);
    expect((await remove()).json()).toMatchObject({error:'device-online'});
    expect(await store.snapshot(registered.id)).not.toBeNull();
    agent.disconnect();await waitFor(async()=>!(await app.inject({url:'/v1/devices',headers:account.headers})).json().devices[0].online);
    expect((await remove()).statusCode).toBe(200);expect(await client.wait(m=>m.type==='device.removed')).toMatchObject({deviceId:registered.id});
    expect((await app.inject({url:'/v1/devices',headers:account.headers})).json().devices).toEqual([]);
    expect((await app.inject({url:`/v1/devices/${registered.id}/catalog`,headers:account.headers})).statusCode).toBe(404);
    expect(await store.snapshot(registered.id)).toBeNull();expect(await store.catalog(registered.id)).toBeNull();
    await client.close();client=undefined;await app.close();
    store=await RelayStore.open(undefined,db);app=await createRelay({store});base=await app.listen({port:0});
    expect((await app.inject({url:'/v1/devices',headers:account.headers})).json().devices).toEqual([]);
    const newTicket=await store.ticket((await store.sessionPrincipal(account.session))!);
    client=await WsPeer.open(base.replace('http','ws')+'/v1/ws/client');client.send({type:'client.authenticate',ticket:newTicket.ticket});await client.wait(m=>m.type==='client.authenticated');
    // Same running Agent, same device ID/session; only the test Relay address changes.
    credentials.relayUrl=base;agent.reconnect();
    await client.wait(m=>m.type==='devices.changed');
    await waitFor(async()=>!!await store.snapshot(registered.id)&&!!await store.catalog(registered.id));
    const devices=(await app.inject({url:'/v1/devices',headers:account.headers})).json().devices;
    expect(devices).toHaveLength(1);expect(devices[0]).toMatchObject({id:registered.id,online:true});
    expect(await readFile(path,'utf8')).toBe('preserve local file');
    expect((await app.inject({url:`/v1/agent/${registered.id}/session`,headers:{authorization:`Bearer ${registered.token}`}})).statusCode).toBe(200);
  }finally{await client?.close();await agent?.stop();await app.close();await desktop.close();await rm(directory,{recursive:true,force:true});}
});
