import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {expect,it,vi} from 'vitest';
import {ServerUpdates} from '../apps/relay/src/updates/service.js';
import {acceptsHealth,activateRelease,archiveEntries,download,extractArchive} from '../scripts/server-updater.js';
import {downloadURL,newerVersion,parseRelease} from '../packages/shared/src/server-update.js';
import {RelayStore} from '../apps/relay/src/storage/store.js';
import {createRelay} from '../apps/relay/src/server.js';
import {testAccount} from './account-helpers.js';
const release=(version='0.2.0') => ({tag_name:'v'+version,html_url:`https://github.com/bunnya33/codexer/releases/tag/v${version}`,body:'Synthetic release',assets:['tar.gz','tar.gz.sha256'].map(suffix => ({name:`codexer-server-${version}.${suffix}`,browser_download_url:`https://github.com/bunnya33/codexer/releases/download/v${version}/codexer-server-${version}.${suffix}`}))});
const fetcher=() => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(release())));
function tar(name: string, text='example', type='0') {
  const h=Buffer.alloc(512);h.write(name);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(Buffer.byteLength(text).toString(8).padStart(11,'0')+'\0',124);h.fill(32,148,156);h.write(type,156);h.write('ustar\0',257);const sum=[...h].reduce((a,b) => a+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
  const body=Buffer.alloc(Math.ceil(Buffer.byteLength(text)/512)*512);body.write(text);return gzipSync(Buffer.concat([h,body,Buffer.alloc(1024)]));
}
it('compares stable numeric versions, rejects prereleases and requires both fixed-repository assets',() => {
  expect(newerVersion('0.10.0','0.9.0')).toBe(true);expect(newerVersion('v1.0.0','1.0.0')).toBe(false);expect(newerVersion('0.1.0','1.0.0')).toBe(false);
  expect(() => newerVersion('1.0.0-beta','1.0.0')).toThrow();expect(parseRelease(release())).toMatchObject({version:'0.2.0'});
  for(const value of [{...release(),draft:true},{...release(),prerelease:true},{...release(),assets:[]},{...release(),html_url:'https://evil.example/'}]) expect(() => parseRelease(value)).toThrow();
  for(const url of ['http://github.com/bunnya33/codexer/releases/download/v1/file','https://github.com/other/project/releases/download/v1/file','https://github.com.evil.example/file','https://user@github.com/bunnya33/codexer/releases/download/v1/file','https://127.0.0.1/file']) expect(() => downloadURL(url)).toThrow();
});
it('bounds streamed downloads and validates every redirect destination',async () => {
  const url=parseRelease(release()).asset;
  const redirect=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:302,headers:{location:'https://internal.example/private'}}));
  await expect(download(url,10,redirect)).rejects.toThrow('invalid-download-url');expect(redirect).toHaveBeenCalledTimes(1);
  await expect(download(url,3,vi.fn<typeof fetch>().mockResolvedValue(new Response('long')))).rejects.toThrow('download-too-large');
  expect((await download(url,10,vi.fn<typeof fetch>().mockResolvedValue(new Response('test')))).toString()).toBe('test');
});
it('extracts files without links or traversal, and validates tar headers before writing',async () => {
  const root=await mkdtemp(join(tmpdir(),'update-archive-'));
  try {
    await extractArchive(tar('codexer/package.json','{"version":"0.2.0"}'),root);
    expect(JSON.parse(await readFile(join(root,'codexer/package.json'),'utf8'))).toEqual({version:'0.2.0'});
    for(const name of ['../escaped','/codexer/file','codexer/../../escaped','codexer/./file','codexer\\escaped','other/file']) expect(() => archiveEntries(tar(name))).toThrow('unsafe-archive-path');
    for(const type of ['1','2','3','4','6']) expect(() => archiveEntries(tar('codexer/link','target',type))).toThrow('unsafe-archive-entry');
    await expect(extractArchive(tar('codexer/package.json','overwrite'),root)).rejects.toMatchObject({code:'EEXIST'});
  } finally {await rm(root,{recursive:true,force:true});}
});
it('accepts actual PAX archives with long UTF-8 names on GNU tar and bsdtar',async () => {
  const root=await mkdtemp(join(tmpdir(),'update-pax-')), name='a'.repeat(110)+'-示例.txt', archive=join(root,'bundle.tar.gz');
  try {
    await mkdir(join(root,'codexer'));await writeFile(join(root,'codexer',name),'synthetic-long-file');
    const result=spawnSync('tar',['--format=pax','-czf',archive,'-C',root,'codexer'],{encoding:'utf8'});
    expect(result.status,result.stderr).toBe(0);
    expect(archiveEntries(await readFile(archive))).toEqual(expect.arrayContaining([{path:'codexer/'+name,data:Buffer.from('synthetic-long-file')}]));
  } finally {await rm(root,{recursive:true,force:true});}
});
it('keeps a healthy activation and restores the previous release when start or health fails',async () => {
  for(const failure of ['none','health','start']) {
    const calls: string[]=[];let active='old';
    const result=await activateRelease('new','old',{stop:async () => {calls.push('stop');},switchTo:async p => {active=p;calls.push(p);},start:async () => {calls.push('start');if(failure==='start' && active==='new') throw new Error('startup-failed');},healthy:async () => failure!=='health'});
    expect(result).toBe(failure==='none'?'succeeded':'rolled-back');expect(active).toBe(failure==='none'?'new':'old');
    expect(calls).toEqual(failure==='none'?['stop','new','start']:['stop','new','start','stop','old','start']);
  }
});
it('requires the new version in activation health but accepts the old v0.1 health shape on rollback',() => {
  expect(acceptsHealth({ok:true,version:'0.2.0'},'0.2.0')).toBe(true);
  expect(acceptsHealth({ok:true,version:'0.1.0'},'0.2.0')).toBe(false);
  expect(acceptsHealth({ok:true},'0.2.0')).toBe(false);
  expect(acceptsHealth({ok:true},'0.1.0',true)).toBe(true);
  expect(acceptsHealth({ok:false},'0.1.0',true)).toBe(false);
});
it('caches checks, preserves a failed-check warning, prevents concurrent jobs, and survives Relay restarts',async () => {
  const root=await mkdtemp(join(tmpdir(),'update-jobs-')), status=join(root,'status.json'), fetch=fetcher();
  // Response bodies must be new per check.
  fetch.mockImplementation(async () => new Response(JSON.stringify(release())));
  const service=new ServerUpdates('0.1.0',root,status,fetch);
  try {
    await writeFile(status,JSON.stringify({enabled:true,protocol:2,job:null}));
    expect(await service.info()).toMatchObject({hasUpdate:true,supported:true,autoInstall:false});await service.info();expect(fetch).toHaveBeenCalledTimes(1);
    await service.setAutoInstall(true);expect((await service.info()).autoInstall).toBe(true);
    const results=await Promise.allSettled([service.request('v0.2.0'),service.request('v0.2.0')]);expect(results.filter(r => r.status==='fulfilled')).toHaveLength(1);
    const job=JSON.parse(await readFile(join(root,'request.json'),'utf8'));expect(job).toMatchObject({phase:'queued',tag:'v0.2.0'});
    const restored=new ServerUpdates('0.1.0',root,status,fetch);expect((await restored.info()).job?.id).toBe(job.id);
    await writeFile(status,JSON.stringify({enabled:true,protocol:2,job:{...job,phase:'installing'}}));expect((await restored.info()).job?.phase).toBe('installing');
    await expect(service.request('v0.2.0')).rejects.toThrow('update-in-progress');
    fetch.mockRejectedValueOnce(new TypeError('offline'));expect(await service.info(true)).toMatchObject({warning:'offline',hasUpdate:true});
    const unsupported=new ServerUpdates('0.1.0',root,join(root,'missing'),fetch);await expect(unsupported.request('v0.2.0')).rejects.toThrow('updater-not-installed');
  } finally {service.close();await rm(root,{recursive:true,force:true});}
});
it('requires an admin session for updates and validates request bodies without invoking privileged work',async () => {
  const root=await mkdtemp(join(tmpdir(),'update-api-')), status=join(root,'status.json');await writeFile(status,JSON.stringify({enabled:true,protocol:2,job:null}));
  const updates=new ServerUpdates('0.1.0',root,status,vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(release()))));
  const store=await RelayStore.open(), admin=await testAccount(store,'admin','admin'), user=await testAccount(store);
  const app=await createRelay({store,updates,version:'0.1.0'});
  try {
    for(const url of ['/v1/admin/system/version','/v1/admin/overview']) {expect((await app.inject({url})).statusCode).toBe(401);expect((await app.inject({url,headers:user.headers})).statusCode).toBe(403);}
    expect((await app.inject({method:'POST',url:'/v1/admin/system/update',headers:user.headers,payload:{tag:'v0.2.0'}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/v1/admin/system/update',headers:admin.headers,payload:{tag:'https://evil.example/file'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/v1/admin/system/update',headers:admin.headers,payload:{tag:'v0.1.1'}})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:'/v1/admin/system/update',headers:admin.headers,payload:{tag:'v0.2.0'}})).json()).toMatchObject({phase:'queued'});
    expect((await app.inject({url:'/health'})).json()).toMatchObject({version:'0.1.0'});
  } finally {updates.close();await app.close();await rm(root,{recursive:true,force:true});}
});
