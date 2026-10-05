import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {RelayStore} from '../apps/relay/src/storage/store.js';
import {createRelay} from '../apps/relay/src/server.js';
import {testAccount,testPassword} from './account-helpers.js';
import {hashPassword} from '../packages/shared/src/accounts.js';
let store: RelayStore, app: Awaited<ReturnType<typeof createRelay>>, admin: Awaited<ReturnType<typeof testAccount>>, user: typeof admin;
beforeAll(async () => {store=await RelayStore.open();admin=await testAccount(store,'Same','admin');user=await testAccount(store,'Same','user');app=await createRelay({store});});
afterAll(async () => app.close());
it('enforces independent login namespaces and disallows admins from control transports',async () => {
  for(const [url,role,id] of [['/v1/admin/auth/login','admin',admin.id],['/v1/auth/login','user',user.id]]) {
    const response=await app.inject({method:'POST',url:url!,payload:{username:'same',password:testPassword}});
    expect(response.json()).toMatchObject({role,userId:id});
  }
  expect((await app.inject({url:'/v1/users',headers:admin.headers})).json().users).toMatchObject([{id:user.id,role:'user'}]);
  expect((await app.inject({url:'/v1/admin/accounts',headers:admin.headers})).json()).toMatchObject({users:[{id:admin.id,role:'admin'}],currentUserId:admin.id});
  for(const url of ['/v1/admin/accounts','/v1/admin/overview','/v1/admin/system/version']) expect((await app.inject({url,headers:user.headers})).statusCode).toBe(403);
  expect((await app.inject({url:'/v1/devices',headers:admin.headers})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/v1/ws/tickets',headers:admin.headers})).statusCode).toBe(403);
  const legacy=await store.registerAgent(admin.id,randomUUID(),'Legacy admin PC','win32'), session=await store.createSession(admin.id,legacy);
  expect(await store.authorizeDevice(legacy,session.session)).toBe(false);
  await expect(store.ticket((await store.sessionPrincipal(admin.session))!)).rejects.toThrow('control-account-required');
});
it('guards both account routes and keeps self/last-admin protection on the server',async () => {
  expect((await app.inject({method:'PUT',url:`/v1/users/${admin.id}/password`,headers:admin.headers,payload:{password:'new-admin-password'}})).statusCode).toBe(404);
  expect((await app.inject({method:'PUT',url:`/v1/admin/accounts/${user.id}/password`,headers:admin.headers,payload:{password:'new-admin-password'}})).statusCode).toBe(404);
  expect((await app.inject({method:'DELETE',url:`/v1/admin/accounts/${admin.id}`,headers:admin.headers})).statusCode).toBe(409);
  const other=await app.inject({method:'POST',url:'/v1/admin/accounts',headers:admin.headers,payload:{username:'Second',password:testPassword}});
  expect(other.statusCode).toBe(200);
  const login=await app.inject({method:'POST',url:'/v1/admin/auth/login',payload:{username:'Second',password:testPassword}});
  const secondSession=login.json().session;
  expect((await app.inject({method:'POST',url:'/v1/auth/login',payload:{username:'Second',password:testPassword}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/v1/agents/login',payload:{username:'Second',password:testPassword,installationId:randomUUID(),name:'PC',platform:'win32'}})).statusCode).toBe(401);
  expect((await app.inject({method:'DELETE',url:`/v1/admin/accounts/${other.json().id}`,headers:admin.headers})).statusCode).toBe(200);
  expect(await store.sessionPrincipal(secondSession)).toBeNull();
  await expect(store.revokeUser(admin.id,'admin','synthetic-other-admin')).rejects.toThrow('admin-disable-protected');
  expect((await app.inject({method:'PUT',url:`/v1/admin/accounts/${admin.id}/password`,headers:admin.headers,payload:{password:'different-admin-password'}})).statusCode).toBe(200);
  expect(await store.sessionPrincipal(admin.session)).toBeNull();
  expect(await store.checkPassword('Same',testPassword,'user')).toMatchObject({id:user.id});
  expect(await store.checkPassword('Same',testPassword,'admin')).toBeNull();
  expect(await store.checkPassword('Same','different-admin-password','admin')).toMatchObject({id:admin.id});
});
it('migrates the old global unique index without removing admin credentials or PC data',async () => {
  const root=await mkdtemp(join(tmpdir(),'admin-role-migration-'));
  const db=new PGlite(root);await db.waitReady;
  await db.query("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE,password_hash TEXT,role TEXT DEFAULT 'user',created_at BIGINT NOT NULL,revoked_at BIGINT)");
  await db.query('CREATE UNIQUE INDEX account_login ON users(lower(name)) WHERE password_hash IS NOT NULL');
  await db.query("INSERT INTO users(id,name,password_hash,role,created_at) VALUES('old-admin','admin',$1,'admin',1)",[await hashPassword(testPassword)]);await db.close();
  const migrated=await RelayStore.open(undefined,root);
  try {expect(await migrated.checkPassword('admin',testPassword,'admin')).toMatchObject({id:'old-admin'});await migrated.createUser('admin',testPassword,'user');await expect(migrated.createUser('ADMIN',testPassword,'user')).rejects.toMatchObject({code:'23505'});expect(await migrated.listUsers()).toHaveLength(2);}finally {await migrated.close();await rm(root,{recursive:true,force:true});}
});
