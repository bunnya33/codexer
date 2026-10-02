import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, expect, it, vi } from 'vitest';
import { createRelay } from '../apps/relay/src/server.js';
import { RelayStore } from '../apps/relay/src/store.js';
import { testAccount } from './account-helpers.js';
import { waitFor, WsPeer } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

it('only lets admins configure the timeout and applies renewal/expiry to client sessions, independently of PC sessions', async () => {
  const store = await RelayStore.open(), admin = await testAccount(store, 'admin', 'admin'), user = await testAccount(store);
  const deviceId = await store.registerAgent(user.id, randomUUID(), 'Sample PC', 'win32'), agent = await store.createSession(user.id, deviceId);
  const app = await createRelay({store});let now = Date.now();vi.spyOn(Date,'now').mockImplementation(() => now);
  try {
    const path = '/v1/admin/auth-settings';
    expect((await app.inject({url:path})).statusCode).toBe(401);
    expect((await app.inject({url:path,headers:user.headers})).statusCode).toBe(403);
    expect((await app.inject({method:'PUT',url:path,headers:user.headers,payload:{idleTimeoutMinutes:1}})).statusCode).toBe(403);
    expect((await app.inject({url:path,headers:admin.headers})).json()).toEqual({idleTimeoutMinutes:10080});
    for(const idleTimeoutMinutes of [0,-1,1.5,43201,'60']) expect((await app.inject({method:'PUT',url:path,headers:admin.headers,payload:{idleTimeoutMinutes}})).statusCode).toBe(400);
    expect((await app.inject({method:'PUT',url:path,headers:admin.headers,payload:{idleTimeoutMinutes:2}})).json()).toEqual({idleTimeoutMinutes:2});
    const principal = await store.sessionPrincipal(user.session);expect(principal!.expiresAt).toBeLessThanOrEqual(now+120000);
    const fresh = await store.createSession(user.id);expect(fresh.expiresAt).toBe(now+120000);
    now += 90000;
    const renewed = await app.inject({method:'POST',url:'/v1/auth/active',headers:{authorization:`Bearer ${fresh.session}`}});
    expect(renewed.json()).toEqual({idleTimeoutMinutes:2,expiresAt:now+120000});
    now += 90000;
    expect((await app.inject({url:'/v1/me',headers:user.headers})).statusCode).toBe(401);
    expect((await app.inject({url:'/v1/me',headers:{authorization:`Bearer ${fresh.session}`}})).statusCode).toBe(200);
    expect((await store.sessionPrincipal(agent.session,deviceId))!.expiresAt).toBe(agent.expiresAt);
    now += 30001;
    expect((await app.inject({method:'POST',url:'/v1/auth/active',headers:{authorization:`Bearer ${fresh.session}`}})).statusCode).toBe(401);
    expect(await store.touchSession((await store.sessionPrincipal(agent.session,deviceId))!.sessionHash!)).toBeNull();
  } finally {await app.close();}
});

it('does not extend a browser login through transport heartbeats and closes it at the configured boundary', async () => {
  const store=await RelayStore.open(), account=await testAccount(store);await store.setAuthSettings({idleTimeoutMinutes:1});
  const session=await store.createSession(account.id), principal=await store.sessionPrincipal(session.session), ticket=await store.ticket(principal!);
  const app=await createRelay({store,heartbeatMs:20});let peer: WsPeer|undefined;
  try {
    const base=await app.listen({host:'127.0.0.1',port:0});
    peer=await WsPeer.open(base.replace('http:','ws:')+'/v1/ws/client');peer.send({type:'client.authenticate',ticket:ticket.ticket});
    await peer.wait(message=>message.type==='client.authenticated');
    vi.spyOn(Date,'now').mockReturnValue(session.expiresAt-1);
    // Keep the transport alive: a protocol pong must not renew account activity.
    peer.socket.pong();await new Promise(resolve=>setTimeout(resolve,50));
    expect((await store.sessionPrincipal(session.session))!.expiresAt).toBe(session.expiresAt);
    vi.spyOn(Date,'now').mockReturnValue(session.expiresAt);
    expect(await peer.closed).toBe(4003);
  } finally {peer?.socket.terminate();await app.close();}
});

it('persists policy updates, migrates legacy sessions and never revives expired logins when increasing the timeout', async () => {
  const directory=await mkdtemp(join(tmpdir(),'codexer-session-policy-'));let store: RelayStore|undefined;
  try {
    // An old server database has no activity column or policy table.
    const legacy=new PGlite(directory);await legacy.waitReady;
    await legacy.query('CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE,created_at BIGINT NOT NULL,revoked_at BIGINT)');
    await legacy.query('CREATE TABLE devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,platform TEXT NOT NULL,token_hash TEXT UNIQUE,created_at BIGINT NOT NULL,last_seen_at BIGINT,revoked_at BIGINT)');
    await legacy.query('CREATE TABLE sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),device_id TEXT REFERENCES devices(id),expires_at BIGINT NOT NULL)');
    await legacy.query("INSERT INTO users(id,name,created_at) VALUES('legacy','Legacy',1)");
    await legacy.query("INSERT INTO sessions(hash,user_id,expires_at) VALUES('legacy-session','legacy',$1)",[Date.now()+604800000]);await legacy.close();
    store=await RelayStore.open(undefined,directory);const user=await testAccount(store);
    await store.setAuthSettings({idleTimeoutMinutes:1});const session=await store.createSession(user.id);
    vi.spyOn(Date,'now').mockReturnValue(session.expiresAt+1);
    await store.setAuthSettings({idleTimeoutMinutes:1440});expect(await store.sessionPrincipal(session.session)).toBeNull();
    await store.close();store=undefined;vi.restoreAllMocks();
    store=await RelayStore.open(undefined,directory);expect(await store.authSettings()).toEqual({idleTimeoutMinutes:1440});
  } finally {await store?.close();await rm(directory,{recursive:true,force:true});}
});
