// Installed in a root-owned directory, separate from the unprivileged Relay.
// No user-provided URL, shell command, environment, or filesystem target is accepted.
import { constants } from 'node:fs';
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, open, readFile, readlink, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, join, posix, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { downloadURL, latestRelease, newerVersion, RELEASE_REPOSITORY, STABLE_TAG, UPDATE_PROTOCOL } from '../packages/shared/src/server-update.js';
import type { UpdateJob } from '../packages/shared/src/server-update.js';

const root = '/var/lib/codexer-updater', inbox = join(root, 'inbox'), statusPath = join(root, 'status.json');
const current = '/opt/codexer/current', releases = '/opt/codexer/releases';
const terminal = new Set(['succeeded','failed','rolled-back']);
const helper = '/usr/local/lib/codexer-updater/scripts/server-updater.mjs';
type GitStage = {id: string; tag: string; commit: string; phase: 'fetched' | 'built'; releasePath?: string};
export function validUpdateRequest(value: unknown): value is UpdateJob {
  const job = value as UpdateJob;
  return Boolean(job && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(job.id) && STABLE_TAG.test(job.tag) && job.phase === 'queued'
    && (job.method === undefined || job.method === 'release' || job.method === 'git')
    && (job.action === undefined || ['update','build','restart'].includes(job.action))
    && (job.method === 'git' || job.action === undefined || job.action === 'update' || job.action === 'restart'));
}
async function atomic(path: string, value: unknown, mode = 0o644) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value), {mode, flag: 'wx'}); await rename(temporary, path);
}
async function smallJSON(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {if ((await file.stat()).size > 16384) throw new Error('invalid-update-request'); return JSON.parse(await file.readFile('utf8'));} finally {await file.close();}
}
export async function download(value: string, limit: number, fetcher: typeof fetch = fetch): Promise<Buffer> {
  let url = downloadURL(value);
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetcher(url, {redirect: 'manual', signal: AbortSignal.timeout(180000), headers: {'user-agent': 'Codexer-server-updater'}});
    if ([301,302,303,307,308].includes(response.status)) {const location = response.headers.get('location'); if (!location) throw new Error('download-failed'); url = downloadURL(new URL(location, url).href); continue;}
    if (!response.ok || !response.body) throw new Error('download-failed');
    if (Number(response.headers.get('content-length')) > limit) throw new Error('download-too-large');
    const reader = response.body.getReader(), chunks: Buffer[] = []; let bytes = 0;
    try {while (true) {const {done, value: chunk} = await reader.read(); if (done) break; bytes += chunk.length; if (bytes > limit) throw new Error('download-too-large'); chunks.push(Buffer.from(chunk));}} finally {await reader.cancel();}
    return Buffer.concat(chunks);
  }
  throw new Error('download-redirect-limit');
}
function octal(header: Buffer, start: number, length: number) {
  const value = header.subarray(start, start + length).toString('ascii').replace(/\0/g, '').trim();
  if (!/^[0-7]*$/.test(value)) throw new Error('invalid-archive');
  const n = parseInt(value || '0', 8); if (!Number.isSafeInteger(n)) throw new Error('invalid-archive'); return n;
}
function cstring(b: Buffer) {return b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)).toString('utf8');}
// Parse before writing. Reject links, devices, traversal, duplicate entries and archive bombs.
// Supported tar formats: ustar and per-entry POSIX PAX metadata, as produced by package:server.
export function archiveEntries(compressed: Buffer): {path: string; data: Buffer | null}[] {
  const data = gunzipSync(compressed, {maxOutputLength: 512 * 1024 * 1024});
  const entries: {path: string; data: Buffer | null}[] = [], seen = new Set<string>();
  let pax: Record<string,string> = {};
  for (let offset = 0; offset + 512 <= data.length;) {
    const h = data.subarray(offset, offset + 512); if (h.every(b => b === 0)) break;
    const checksum = [...h].reduce((sum,b,i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
    if (checksum !== octal(h,148,8)) throw new Error('invalid-archive');
    const size = octal(h,124,12), type = String.fromCharCode(h[156]!);
    offset += 512; if (offset + size > data.length) throw new Error('invalid-archive');
    const body = data.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    if (type === 'x') {
      if (size > 16384) throw new Error('invalid-archive');
      for (let cursor = 0; cursor < body.length;) {
        const space = body.indexOf(32, cursor), length = body.subarray(cursor, space).toString('ascii'), n = Number(length);
        if (space < cursor || !/^\d+$/.test(length) || !Number.isInteger(n) || n <= space - cursor + 1 || cursor + n > body.length || body[cursor + n - 1] !== 10) throw new Error('invalid-archive');
        const item = body.subarray(space + 1, cursor + n - 1).toString('utf8'), equals = item.indexOf('=');
        if (equals < 0) throw new Error('invalid-archive'); pax[item.slice(0,equals)] = item.slice(equals+1); cursor += n;
      }
      if (pax.size || pax.linkpath) throw new Error('invalid-archive');
      continue;
    }
    if (!['0','\0','5'].includes(type)) throw new Error('unsafe-archive-entry');
    const prefix = cstring(h.subarray(345,500)), name = pax.path ?? (prefix ? prefix + '/' : '') + cstring(h.subarray(0,100)); pax = {};
    const normalized = name.replace(/\/$/, '');
    if (!/^codexer(?:\/[^\x00-\x1f\\:]+)*$/.test(normalized) || normalized.split('/').some(p => !p || p === '..' || p === '.') || seen.has(normalized)) throw new Error('unsafe-archive-path');
    seen.add(normalized); if (seen.size > 30000) throw new Error('archive-too-many-files');
    entries.push({path: normalized, data: type === '5' ? null : body});
  }
  if (!entries.length) throw new Error('invalid-archive'); return entries;
}
export async function extractArchive(compressed: Buffer, target: string) {
  const entries = archiveEntries(compressed);
  // Fresh root-owned directory; archives cannot create links or overwrite existing entries.
  for (const entry of entries) {
    const path = join(target, entry.path);
    if (entry.data === null) await mkdir(path, {recursive: true, mode: 0o755});
    else {await mkdir(dirname(path), {recursive: true, mode: 0o755}); await writeFile(path, entry.data, {mode: 0o644, flag: 'wx'});}
  }
}
export type Activation = {stop: () => Promise<void>; switchTo: (release: string) => Promise<void>; start: () => Promise<void>; healthy: () => Promise<boolean>};
export async function activateRelease(next: string, previous: string, activation: Activation): Promise<'succeeded' | 'rolled-back'> {
  try {await activation.stop(); await activation.switchTo(next); await activation.start(); if (!await activation.healthy()) throw new Error('health-check-failed'); return 'succeeded';}
  catch {await activation.stop(); await activation.switchTo(previous); await activation.start(); return 'rolled-back';}
}
async function run(command: string, args: string[], cwd?: string, timeout = 10 * 60000, stream = false): Promise<string> {
  let output = '';
  await new Promise<void>((done, reject) => {
    const child = spawn(command, args, {cwd, stdio: ['ignore','pipe',stream?'inherit':'ignore'], env: {...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0', ...(cwd ? {npm_config_cache: join(cwd,'.npm-cache')} : {}), npm_config_ignore_scripts: 'true', ELECTRON_SKIP_BINARY_DOWNLOAD: '1'}});
    child.stdout.on('data', chunk => {output = (output + chunk.toString()).slice(-65536); if (stream) process.stdout.write(chunk);});
    const timer = setTimeout(() => {child.kill('SIGKILL'); reject(new Error('command-timeout'));}, timeout);
    child.on('error', error => {clearTimeout(timer); reject(error);}); child.on('close', code => {clearTimeout(timer); code === 0 ? done() : reject(new Error('install-command-failed'));});
  });
  return output.trim();
}
const gitOptions = ['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','-c','protocol.ext.allow=never'];
export async function fetchGitTag(target: string, tag: string, command = run): Promise<string> {
  if (!STABLE_TAG.test(tag)) throw new Error('invalid-git-tag');
  await command('git', [...gitOptions,'init',target]);
  await command('git', [...gitOptions,'-C',target,'remote','add','origin',`https://github.com/${RELEASE_REPOSITORY}.git`]);
  await command('git', [...gitOptions,'-C',target,'fetch','--depth=1','--no-tags','origin',`refs/tags/${tag}:refs/tags/${tag}`]);
  const commit = await command('git', [...gitOptions,'-C',target,'rev-parse','--verify',`refs/tags/${tag}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('invalid-git-commit');
  await command('git', [...gitOptions,'-C',target,'checkout','--detach',commit]);
  const manifest = JSON.parse(await readFile(join(target,'package.json'),'utf8')) as {version?: string};
  if (manifest.version !== tag.slice(1)) throw new Error('tag-version-mismatch');
  return commit;
}
export function buildUnitArgs(id: string, workspace: string, executable = process.execPath): string[] {
  if (!/^[\da-f-]{36}$/.test(id) || workspace !== posix.join(releases, '.git-stage-' + id, 'codexer')) throw new Error('invalid-build-workspace');
  return ['--unit=codexer-build-'+id,'--wait','--collect',
    '--property=User=codexer-builder','--property=Group=codexer-builder',
    '--property=WorkingDirectory='+workspace,'--property=ReadWritePaths='+workspace,
    '--property=ProtectSystem=strict','--property=ProtectHome=true','--property=PrivateTmp=true',
    '--property=PrivateDevices=true','--property=NoNewPrivileges=true','--property=CapabilityBoundingSet=',
    '--property=RestrictSUIDSGID=true','--property=ProtectKernelTunables=true','--property=ProtectKernelModules=true','--property=ProtectControlGroups=true',
    '--property=InaccessiblePaths=/etc/codexer /var/lib/codexer /var/lib/codexer-updater -/run/dbus -/run/systemd/private',
    '--property=RuntimeMaxSec=1800','--property=TimeoutStopSec=20','--property=KillMode=control-group',
    '--property=StandardOutput=journal','--property=StandardError=journal',
    '--setenv=PATH='+dirname(executable)+':/usr/local/bin:/usr/bin:/bin','--setenv=CI=1',
    // Expo reads this shell-only override before loading project .env files.
    // Keep its settings/cache in the writable workspace without exposing a user's home.
    '--setenv=__UNSAFE_EXPO_HOME_DIRECTORY='+posix.join(workspace,'.expo-home'),'--setenv=EXPO_NO_TELEMETRY=1',
    '--setenv=NODE_OPTIONS=--no-global-search-paths',
    executable,helper,'--build-worker',workspace];
}
async function prepareBuilder(path: string, uid: number, gid: number) {
  const info = await lstat(path);
  // Git source may contain links. Reject them before handing the workspace to the builder.
  if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error('unsafe-git-source');
  if (info.isDirectory()) for (const name of await readdir(path)) await prepareBuilder(join(path,name),uid,gid);
  await chown(path,uid,gid);
}
async function copyBuildSource(source: string, target: string) {
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error('unsafe-git-source');
  if (info.isDirectory()) {
    await mkdir(target,{mode:0o700});
    for (const name of await readdir(source)) if (name !== '.git') await copyBuildSource(join(source,name),join(target,name));
  } else await copyFile(source,target);
}
async function buildWorker(workspace: string) {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || !/^\/opt\/codexer\/releases\/\.git-stage-[\da-f-]{36}\/codexer$/.test(workspace)) throw new Error('invalid-build-worker');
  await run('npm',['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund'],workspace,10*60000,true);
  await run('npm',['run','build:server'],workspace,20*60000,true);
  await run('npm',['run','package:server'],workspace,10*60000,true);
}
async function switchTo(path: string) {
  const temporary = current + '.' + randomUUID(); await symlink(path, temporary); await rename(temporary, current);
}
export function acceptsHealth(value: {ok?: boolean; version?: string}, version: string, allowLegacy = false): boolean {
  return value.ok === true && (value.version === version || allowLegacy && value.version === undefined);
}
async function healthy(port: number, version: string, allowLegacy = false) {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(1500)});
      const health = await response.json() as {ok: boolean; version: string};
      if (response.ok && acceptsHealth(health, version, allowLegacy)) {
        const pages = await Promise.all(['/', '/admin/'].map(p => fetch(`http://127.0.0.1:${port}${p}`, {signal: AbortSignal.timeout(1500)})));
        if (pages.every(p => p.ok && p.headers.get('content-type')?.includes('text/html'))) return true;
      }
    } catch { /* The service is restarting. */ }
    await new Promise(done => setTimeout(done, 500));
  }
  return false;
}
async function execute() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('managed-linux-root-required');
  const env = parseEnv(await readFile('/etc/codexer/relay.env', 'utf8')), port = Number(env.RELAY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid-installed-config');
  let prior: {enabled: boolean; job: UpdateJob | null} = {enabled: true, job: null};
  try {prior = await smallJSON(statusPath) as typeof prior;} catch { /* First run. */ }
  const gitSupported = await Promise.all([run('git',['--version']),run('id',['-u','codexer-builder']),run('id',['-g','codexer-builder'])]).then(() => true, () => false);
  const status = (job: UpdateJob | null) => ({enabled:true,protocol:UPDATE_PROTOCOL,gitSupported,job});
  const rollbackPath = join(root, 'rollback.json');
  // Recover a process/power interruption after activation began. The journal is root-owned.
  try {
    const recovery = await smallJSON(rollbackPath) as {previous: string};
    if (!recovery.previous.startsWith(releases + '/') || recovery.previous.includes('..')) throw new Error('invalid-rollback-journal');
    await run('systemctl',['stop','codexer-relay.service']); await switchTo(recovery.previous); await run('systemctl',['start','codexer-relay.service']);
    if (prior.job) prior.job = {...prior.job, phase: 'rolled-back', code: 'update-interrupted', updatedAt: Date.now()};
    await rm(rollbackPath); await rm(join(inbox, 'request.json'), {force: true});
  } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  await atomic(statusPath, status(prior.job));
  let request: UpdateJob;
  try {request = await smallJSON(join(inbox, 'request.json')) as UpdateJob;} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
  if (!validUpdateRequest(request)) {await rm(join(inbox,'request.json'), {force: true}); return;}
  if (prior.job?.id === request.id && terminal.has(prior.job.phase) && prior.job.phase !== 'failed') {await rm(join(inbox,'request.json'),{force:true}); return;}
  const publish = async (phase: UpdateJob['phase'], code?: string) => {request = {...request, phase, updatedAt:Date.now(), code}; await atomic(statusPath,status(request));};
  let temporary: string | undefined;
  try {
    if (request.method === 'git') {
      if (!gitSupported) throw new Error('git-updater-not-installed');
      const stagePath = join(root,'git-stage.json');
      let stage: GitStage | null = null;
      try {stage = await smallJSON(stagePath) as GitStage;} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      if (stage && (!/^[\da-f-]{36}$/.test(stage.id) || !STABLE_TAG.test(stage.tag) || !/^[a-f0-9]{40}$/.test(stage.commit) || !['fetched','built'].includes(stage.phase) || stage.releasePath && stage.releasePath !== join(releases,stage.tag.slice(1)+'-git-'+stage.id))) throw new Error('invalid-git-stage');
      const workspaceRoot = join(releases,'.git-stage-'+request.id), workspace = join(workspaceRoot,'codexer'), source = join(workspaceRoot,'source');
      const installed = JSON.parse(await readFile(join(current,'package.json'),'utf8')) as {version:string};
      if (!newerVersion(request.tag.slice(1),installed.version)) throw new Error('update-not-current');
      if ((request.action ?? 'update') === 'update') {
        if (stage?.id === request.id && stage.tag === request.tag) {request.commit = stage.commit; await publish(stage.phase); return;}
        if (stage) {await rm(join(releases,'.git-stage-'+stage.id),{recursive:true,force:true}); if (stage.releasePath) await rm(stage.releasePath,{recursive:true,force:true}); await rm(stagePath);}
        await publish('fetching');
        await rm(workspaceRoot,{recursive:true,force:true});
        await mkdir(workspaceRoot,{mode:0o711}); await mkdir(source,{mode:0o700});
        const commit = await fetchGitTag(source,request.tag).catch(error => {if (['tag-version-mismatch','unsafe-git-source'].includes(error.message)) throw error; throw new Error('git-fetch-failed');});
        stage = {id:request.id,tag:request.tag,commit,phase:'fetched'};
        await atomic(stagePath,stage,0o600); request.commit = commit; await publish('fetched');
        return;
      }
      if (!stage || stage.id !== request.id || stage.tag !== request.tag) throw new Error('update-step-not-ready');
      request.commit = stage.commit;
      if (request.action === 'build') {
        if (stage.phase === 'built') {await publish('built'); return;}
        await publish('building');
        const unit = 'codexer-build-'+request.id+'.service';
        await run('systemctl',['stop',unit]).catch(() => undefined);
        await rm(workspace,{recursive:true,force:true}); await copyBuildSource(source,workspace);
        await prepareBuilder(workspace,Number(await run('id',['-u','codexer-builder'])),Number(await run('id',['-g','codexer-builder'])));
        try {await run('systemd-run',buildUnitArgs(request.id,workspace),undefined,32*60000);}
        catch {throw new Error('build-command-failed');}
        finally {await run('systemctl',['stop',unit]).catch(() => undefined);}
        const file = await open(join(workspace,'release',`codexer-server-${request.tag.slice(1)}.tar.gz`),constants.O_RDONLY|constants.O_NOFOLLOW);
        let archive: Buffer;
        try {if ((await file.stat()).size > 256*1024*1024) throw new Error('download-too-large'); archive = await file.readFile();} finally {await file.close();}
        temporary = await mkdtemp(join(releases,'.update-')); await chmod(temporary,0o700);
        await extractArchive(archive,temporary);
        const staged = join(temporary,'codexer');
        const manifest = JSON.parse(await readFile(join(staged,'package.json'),'utf8')) as {version:string};
        const marker = JSON.parse(await readFile(join(staged,'server-bundle.json'),'utf8')) as {kind:string;version:string};
        if (manifest.version !== request.tag.slice(1) || marker.version !== manifest.version || marker.kind !== 'codexer-server-bundle') throw new Error('invalid-server-bundle');
        for (const name of ['dist/apps/relay/src/main.js','apps/web/dist/index.html','apps/admin/dist/index.html']) await readFile(join(staged,name));
        await publish('installing'); await run('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],staged);
        await rm(join(staged,'.npm-cache'),{recursive:true,force:true});
        await writeFile(join(staged,'VERSION'),manifest.version+'\n');
        await writeFile(join(staged,'git-version.json'),JSON.stringify({tag:stage.tag,commit:stage.commit}));
        const next = join(releases,manifest.version+'-git-'+stage.id);
        await rm(next,{recursive:true,force:true}); await rename(staged,next);
        stage = {...stage,phase:'built',releasePath:next}; await atomic(stagePath,stage,0o600); await publish('built');
        await rm(workspaceRoot,{recursive:true,force:true});
        return;
      }
      if (request.action !== 'restart' || stage.phase !== 'built' || !stage.releasePath) throw new Error('update-step-not-ready');
      const previous = await readlink(current);
      await atomic(rollbackPath,{previous},0o600); await publish('restarting');
      const result = await activateRelease(stage.releasePath,previous,{stop:async () => {await run('systemctl',['stop','codexer-relay.service']);},start:async () => {await run('systemctl',['start','codexer-relay.service']);},switchTo,healthy:() => healthy(port,stage!.tag.slice(1))});
      if (result === 'rolled-back' && !await healthy(port,installed.version,true)) throw new Error('rollback-health-failed');
      await rm(rollbackPath); await rm(stagePath); await publish(result,result === 'rolled-back' ? 'health-check-failed' : undefined);
      return;
    }
    const preparedPath = join(root,'release-stage.json');
    type Prepared = {id:string;tag:string;releasePath:string};
    let prepared: Prepared | null = null;
    try {prepared = await smallJSON(preparedPath) as Prepared;} catch(error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    if (prepared && (!/^[\da-f-]{36}$/.test(prepared.id) || !STABLE_TAG.test(prepared.tag) || prepared.releasePath !== join(releases,prepared.tag.slice(1)+'-update-'+prepared.id))) throw new Error('invalid-release-stage');
    if (request.action === 'restart') {
      if (!prepared || prepared.id !== request.id || prepared.tag !== request.tag) throw new Error('update-step-not-ready');
      const previous = await readlink(current);
      const installed = JSON.parse(await readFile(join(current,'package.json'),'utf8')) as {version:string};
      if (!newerVersion(prepared.tag.slice(1),installed.version)) throw new Error('update-not-current');
      await atomic(rollbackPath,{previous},0o600); await publish('restarting');
      const result = await activateRelease(prepared.releasePath,previous,{stop:async () => {await run('systemctl',['stop','codexer-relay.service']);},start:async () => {await run('systemctl',['start','codexer-relay.service']);},switchTo,healthy:() => healthy(port,prepared!.tag.slice(1))});
      if (result === 'rolled-back' && !await healthy(port,installed.version,true)) throw new Error('rollback-health-failed');
      await rm(rollbackPath); await rm(preparedPath); await publish(result,result === 'rolled-back'?'health-check-failed':undefined);
      return;
    }
    if (prepared?.id === request.id && prepared.tag === request.tag) {await publish('built'); return;}
    if (prepared) {await rm(prepared.releasePath,{recursive:true,force:true}); await rm(preparedPath);}
    await publish('downloading');
    const release = await latestRelease();
    const installed = JSON.parse(await readFile(join(current, 'package.json'),'utf8')) as {version: string};
    if (!release || release.tag !== request.tag || !newerVersion(release.version, installed.version)) throw new Error('update-not-current');
    temporary = await mkdtemp(join(releases, '.update-')); await chmod(temporary, 0o700);
    const checksum = await download(release.checksum, 4096), archive = await download(release.asset, 256 * 1024 * 1024);
    await publish('verifying');
    const expected = /^([a-fA-F0-9]{64})\s+\*?(codexer-server-[\d.]+\.tar\.gz)\s*$/.exec(checksum.toString('utf8'));
    if (!expected || expected[2] !== `codexer-server-${release.version}.tar.gz` || createHash('sha256').update(archive).digest('hex') !== expected[1]!.toLowerCase()) throw new Error('checksum-mismatch');
    await extractArchive(archive, temporary);
    const staged = join(temporary, 'codexer'), marker = JSON.parse(await readFile(join(staged, 'server-bundle.json'),'utf8')) as {kind: string; version: string};
    const manifest = JSON.parse(await readFile(join(staged,'package.json'),'utf8')) as {version: string};
    if (marker.kind !== 'codexer-server-bundle' || marker.version !== release.version || manifest.version !== release.version) throw new Error('invalid-server-bundle');
    for (const file of ['dist/apps/relay/src/main.js','apps/admin/dist/index.html','apps/web/dist/index.html']) await readFile(join(staged,file));
    await publish('installing'); await run('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'], staged);
    await rm(join(staged,'.npm-cache'),{recursive:true,force:true});
    await writeFile(join(staged,'VERSION'), release.version + '\n');
    const next = join(releases,release.version+'-update-'+request.id); await rm(next,{recursive:true,force:true}); await rename(staged,next);
    await atomic(preparedPath,{id:request.id,tag:request.tag,releasePath:next},0o600); await publish('built');
  } catch (error) {
    const codes = ['update-not-current','checksum-mismatch','invalid-server-bundle','unsafe-archive-path','unsafe-archive-entry','invalid-archive','github-rate-limited','rollback-health-failed','install-command-failed','command-timeout','download-failed','download-too-large','git-updater-not-installed','git-fetch-failed','tag-version-mismatch','build-command-failed','unsafe-git-source','update-step-not-ready','invalid-git-stage','invalid-release-stage'];
    await publish('failed', error instanceof Error && codes.includes(error.message) ? error.message : 'update-failed');
  } finally {
    if (temporary) await rm(temporary, {recursive:true,force:true});
    if (request.method === 'git' && (request.action ?? 'update') === 'update' && request.phase === 'failed') await rm(join(releases,'.git-stage-'+request.id),{recursive:true,force:true});
    await rm(join(inbox,'request.json'), {force:true});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--build-worker') await buildWorker(process.argv[3] ?? '');
  else await execute();
}
