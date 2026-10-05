import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it,vi} from 'vitest';
import {ServerUpdates} from '../apps/relay/src/updates/service.js';
import {buildUnitArgs,fetchGitTag,validUpdateRequest} from '../scripts/server-updater.js';
import {nextGitAction,stableTags,UPDATE_PROTOCOL,updateRunning} from '../packages/shared/src/server-update.js';
import {RelayStore} from '../apps/relay/src/storage/store.js';
import {createRelay} from '../apps/relay/src/server.js';
import {testAccount} from './account-helpers.js';

const sha='a'.repeat(40), id='11111111-1111-4111-8111-111111111111';
const tags=[{name:'v0.3.0',commit:{sha}},{name:'v0.2.1',commit:{sha:'b'.repeat(40)}},{name:'v0.4.0-beta',commit:{sha}},{name:'main',commit:{sha}}];
const response=()=>new Response(JSON.stringify(tags));
it('loads stable Git tags independently of Release assets and sorts numerical versions',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>response());
  expect(await stableTags(fetcher)).toEqual([{tag:'v0.3.0',version:'0.3.0',commit:sha},{tag:'v0.2.1',version:'0.2.1',commit:'b'.repeat(40)}]);
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/bunnya33/codexer/tags?per_page=100');
  await expect(stableTags(vi.fn<typeof fetch>().mockResolvedValue(new Response('{}',{status:429})))).rejects.toThrow('github-rate-limited');
  await expect(stableTags(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{name:'v0.3.0',commit:{sha:'bad'}}]))))).rejects.toThrow('invalid-tags');
});
it('rejects injected tags and fixes Git remote, exact tag fetch, commit checkout and package version',async()=>{
  const root=await mkdtemp(join(tmpdir(),'git-fetch-'));
  const command=vi.fn(async(_name:string,args:string[])=>args.includes('rev-parse')?sha:'');
  try{
    await writeFile(join(root,'package.json'),JSON.stringify({version:'0.3.0'}));
    expect(await fetchGitTag(root,'v0.3.0',command)).toBe(sha);
    expect(command.mock.calls).toEqual(expect.arrayContaining([
      ['git',expect.arrayContaining(['remote','add','origin','https://github.com/bunnya33/codexer.git'])],
      ['git',expect.arrayContaining(['fetch','--depth=1','--no-tags','origin','refs/tags/v0.3.0:refs/tags/v0.3.0'])],
      ['git',expect.arrayContaining(['checkout','--detach',sha])],
    ]));
    command.mockClear();await expect(fetchGitTag(root,'--upload-pack=malicious',command)).rejects.toThrow('invalid-git-tag');expect(command).not.toHaveBeenCalled();
    await expect(fetchGitTag(root,'v0.2.1',command)).rejects.toThrow('tag-version-mismatch');
  }finally{await rm(root,{recursive:true,force:true});}
});
it('requires an unprivileged sandboxed build with a fixed workspace, bounded runtime and no shell',()=>{
  const path='/opt/codexer/releases/.git-stage-'+id+'/codexer';
  const args=buildUnitArgs(id,path,'/usr/bin/node');
  expect(args).toEqual(expect.arrayContaining(['--property=User=codexer-builder','--property=ProtectSystem=strict','--property=NoNewPrivileges=true','--property=KillMode=control-group','--property=RuntimeMaxSec=1800','--property=ReadWritePaths='+path]));
  expect(args.at(-2)).toBe('--build-worker');expect(args.at(-1)).toBe(path);
  expect(args.some(a=>a.includes('InaccessiblePaths=/etc/codexer /var/lib/codexer'))).toBe(true);
  expect(args).toEqual(expect.arrayContaining(['--setenv=__UNSAFE_EXPO_HOME_DIRECTORY='+path+'/.expo-home','--setenv=EXPO_NO_TELEMETRY=1','--setenv=NODE_OPTIONS=--no-global-search-paths']));
  expect(()=>buildUnitArgs(id,'/etc','/usr/bin/node')).toThrow('invalid-build-workspace');
  for(const request of [{id,tag:'v0.3.0',phase:'queued'},{id,tag:'v0.3.0',phase:'queued',method:'git',action:'build'}])expect(validUpdateRequest(request)).toBe(true);
  for(const change of [{tag:'main'},{id:'../escape'},{method:'custom'},{method:'release',action:'build'},{action:'shell'}])expect(validUpdateRequest({id,tag:'v0.3.0',phase:'queued',...change})).toBe(false);
});
it('keeps each step distinct, permits failed-step retry and rejects skipping/replaying stale jobs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'git-workflow-')),status=join(root,'status.json');
  const service=new ServerUpdates('0.2.0',root,status,vi.fn<typeof fetch>().mockImplementation(async()=>response()));
  try{
    await writeFile(status,JSON.stringify({enabled:true,protocol:UPDATE_PROTOCOL,gitSupported:true,job:null}));
    await service.setSettings({method:'git'});
    expect(await service.info()).toMatchObject({method:'git',gitSupported:true,autoInstall:false,latestVersion:'0.3.0',release:null});
    await expect(service.setAutoInstall(true)).rejects.toThrow('git-requires-manual-steps');
    await expect(service.request('v0.3.0','build',id)).rejects.toThrow('update-step-not-ready');
    await expect(service.request('v0.2.0')).rejects.toThrow('tag-not-available');
    const pulled=await service.request('v0.3.0');expect(pulled).toMatchObject({method:'git',action:'update',phase:'queued'});
    await expect(service.setSettings({method:'release'})).rejects.toThrow('update-in-progress');
    await writeFile(status,JSON.stringify({enabled:true,protocol:UPDATE_PROTOCOL,gitSupported:true,job:{...pulled,phase:'fetched',commit:sha,updatedAt:Date.now()+10}}));await rm(join(root,'request.json'));
    const restored=new ServerUpdates('0.2.0',root,status,vi.fn<typeof fetch>().mockImplementation(async()=>response()));
    expect(nextGitAction((await restored.info()).job,'v0.3.0')).toBe('build');
    await expect(restored.request('v0.3.0','restart',pulled.id)).rejects.toThrow('update-step-not-ready');
    await expect(restored.request('v0.3.0','build',id)).rejects.toThrow('update-step-not-ready');
    const build=await restored.request('v0.3.0','build',pulled.id);expect(build.commit).toBe(sha);expect(updateRunning((await restored.info()).job)).toBe(true);
    const ready={...build,phase:'built',updatedAt:Date.now()+20};await writeFile(status,JSON.stringify({enabled:true,protocol:UPDATE_PROTOCOL,gitSupported:true,job:ready}));await rm(join(root,'request.json'));
    expect(nextGitAction((await restored.info()).job,'v0.3.0')).toBe('restart');expect(updateRunning((await restored.info()).job)).toBe(false);
    expect(nextGitAction({...build,phase:'failed'},'v0.3.0')).toBe('build');
    const restarted=await restored.request('v0.3.0','restart',pulled.id);expect(restarted.action).toBe('restart');
    await expect(restored.request('v0.3.0','restart',pulled.id)).rejects.toThrow('update-in-progress');
  }finally{service.close();await rm(root,{recursive:true,force:true});}
});
it('does not enable Git on old helpers and atomically preserves settings across switches',async()=>{
  const root=await mkdtemp(join(tmpdir(),'git-settings-')),status=join(root,'status.json');
  const service=new ServerUpdates('0.2.0',root,status,vi.fn<typeof fetch>().mockImplementation(async()=>new Response('{}',{status:404})));
  try{
    await writeFile(status,JSON.stringify({enabled:true,job:null}));
    await expect(service.setAutoInstall(true)).rejects.toThrow('updater-not-installed');await expect(service.request('v0.3.0')).rejects.toThrow('updater-not-installed');
    await writeFile(status,JSON.stringify({enabled:true,protocol:UPDATE_PROTOCOL,gitSupported:true,job:null}));
    await service.setSettings({method:'git'});expect(JSON.parse(await readFile(join(root,'settings.json'),'utf8'))).toEqual({method:'git',autoInstall:false});
    await service.setSettings({method:'release'});expect((await service.info()).method).toBe('release');expect((await service.info()).autoInstall).toBe(false);
  }finally{service.close();await rm(root,{recursive:true,force:true});}
});
it('prepares a Release without restarting, retains the prepared tag and requires the matching restart job',async()=>{
  const root=await mkdtemp(join(tmpdir(),'release-staged-')),status=join(root,'status.json');
  const release={tag_name:'v0.3.0',html_url:'https://github.com/bunnya33/codexer/releases/tag/v0.3.0',assets:['tar.gz','tar.gz.sha256'].map(s=>({name:'codexer-server-0.3.0.'+s,browser_download_url:'https://github.com/bunnya33/codexer/releases/download/v0.3.0/codexer-server-0.3.0.'+s}))};
  const service=new ServerUpdates('0.2.0',root,status,vi.fn<typeof fetch>().mockImplementation(async()=>new Response(JSON.stringify(release))));
  try{
    await writeFile(status,JSON.stringify({enabled:true,protocol:UPDATE_PROTOCOL,job:null}));
    const job=await service.request('v0.3.0');expect(job.action).toBe('update');
    await writeFile(status,JSON.stringify({enabled:true,protocol:UPDATE_PROTOCOL,job:{...job,phase:'built',updatedAt:Date.now()}}));await rm(join(root,'request.json'));
    await expect(service.request('v0.3.0','restart',id)).rejects.toThrow('update-step-not-ready');
    await expect(service.request('v0.4.0','restart',job.id)).rejects.toThrow('update-step-not-ready');
    await expect(service.request('v0.3.0','build',job.id)).rejects.toThrow('update-not-current');
    const restart=await service.request('v0.3.0','restart',job.id);expect(restart).toMatchObject({id:job.id,tag:job.tag,method:'release',action:'restart'});
  }finally{service.close();await rm(root,{recursive:true,force:true});}
});
it('authorizes all Git steps only for administrators and strictly rejects custom commands/URLs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'git-api-')),status=join(root,'status.json');
  await writeFile(status,JSON.stringify({enabled:true,protocol:UPDATE_PROTOCOL,gitSupported:true,job:null}));
  const updates=new ServerUpdates('0.2.0',root,status,vi.fn<typeof fetch>().mockImplementation(async()=>response()));
  await writeFile(join(root,'settings.json'),JSON.stringify({method:'git'}));
  const store=await RelayStore.open(),admin=await testAccount(store,'git-admin','admin'),user=await testAccount(store);
  const app=await createRelay({store,updates});
  try{
    for(const action of ['update','build','restart'])expect((await app.inject({method:'POST',url:'/v1/admin/system/update',headers:user.headers,payload:{tag:'v0.3.0',action}})).statusCode).toBe(403);
    expect((await app.inject({method:'PUT',url:'/v1/admin/system/update-settings',headers:admin.headers,payload:{method:'shell'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/v1/admin/system/update',headers:admin.headers,payload:{tag:'v0.3.0',command:'rm -rf /'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/v1/admin/system/update',headers:admin.headers,payload:{tag:'v0.3.0',action:'restart',jobId:id}})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:'/v1/admin/system/update',headers:admin.headers,payload:{tag:'v0.3.0'}})).json()).toMatchObject({method:'git',action:'update',phase:'queued'});
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
