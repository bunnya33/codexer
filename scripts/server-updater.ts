// Installed in a root-owned directory, separate from the unprivileged Relay.
// No user-provided URL, shell command, environment, or filesystem target is accepted.
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { downloadURL, latestRelease, newerVersion, STABLE_TAG } from '../packages/shared/src/server-update.js';
import type { UpdateJob } from '../packages/shared/src/server-update.js';

const root = '/var/lib/codexer-updater', inbox = join(root, 'inbox'), statusPath = join(root, 'status.json');
const current = '/opt/codexer/current', releases = '/opt/codexer/releases';
const terminal = new Set(['succeeded','failed','rolled-back']);
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
      const text = body.toString('utf8');
      for (let cursor = 0; cursor < text.length;) {
        const space = text.indexOf(' ', cursor), n = Number(text.slice(cursor, space));
        if (!Number.isInteger(n) || n <= space - cursor + 1 || cursor + n > text.length) throw new Error('invalid-archive');
        const item = text.slice(space + 1, cursor + n - 1), equals = item.indexOf('=');
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
async function run(command: string, args: string[], cwd?: string) {
  await new Promise<void>((done, reject) => {
    const child = spawn(command, args, {cwd, stdio: 'ignore', env: {...process.env, ...(cwd ? {npm_config_cache: join(cwd,'.npm-cache')} : {}), npm_config_ignore_scripts: 'true', ELECTRON_SKIP_BINARY_DOWNLOAD: '1'}});
    const timer = setTimeout(() => {child.kill('SIGKILL'); reject(new Error('command-timeout'));}, 10 * 60000);
    child.on('error', error => {clearTimeout(timer); reject(error);}); child.on('close', code => {clearTimeout(timer); code === 0 ? done() : reject(new Error('install-command-failed'));});
  });
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
  const rollbackPath = join(root, 'rollback.json');
  // Recover a process/power interruption after activation began. The journal is root-owned.
  try {
    const recovery = await smallJSON(rollbackPath) as {previous: string};
    if (!recovery.previous.startsWith(releases + '/') || recovery.previous.includes('..')) throw new Error('invalid-rollback-journal');
    await run('systemctl',['stop','codexer-relay.service']); await switchTo(recovery.previous); await run('systemctl',['start','codexer-relay.service']);
    if (prior.job) prior.job = {...prior.job, phase: 'rolled-back', code: 'update-interrupted', updatedAt: Date.now()};
    await rm(rollbackPath); await rm(join(inbox, 'request.json'), {force: true});
  } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  await atomic(statusPath, {...prior, enabled: true});
  let request: UpdateJob;
  try {request = await smallJSON(join(inbox, 'request.json')) as UpdateJob;} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
  if (!request || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(request.id) || !STABLE_TAG.test(request.tag) || request.phase !== 'queued') {await rm(join(inbox,'request.json'), {force: true}); return;}
  if (prior.job?.id === request.id && terminal.has(prior.job.phase)) {await rm(join(inbox,'request.json'),{force:true}); return;}
  const publish = async (phase: UpdateJob['phase'], code?: string) => {request = {id:request.id, tag:request.tag, phase, updatedAt: Date.now(), ...(code ? {code} : {})}; await atomic(statusPath,{enabled: true, job:request});};
  let temporary: string | undefined;
  try {
    await publish('downloading');
    const release = await latestRelease();
    const previous = await readlink(current);
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
    const next = join(releases, release.version + '-update-' + Date.now()); await rename(staged,next);
    await atomic(rollbackPath, {previous}, 0o600); await publish('restarting');
    const result = await activateRelease(next, previous, {stop: () => run('systemctl',['stop','codexer-relay.service']), start: () => run('systemctl',['start','codexer-relay.service']), switchTo, healthy: () => healthy(port, release.version)});
    if (result === 'rolled-back' && !await healthy(port, installed.version, true)) throw new Error('rollback-health-failed');
    await rm(rollbackPath); await publish(result, result === 'rolled-back' ? 'health-check-failed' : undefined);
  } catch (error) {
    const codes = ['update-not-current','checksum-mismatch','invalid-server-bundle','unsafe-archive-path','unsafe-archive-entry','invalid-archive','github-rate-limited','rollback-health-failed','install-command-failed','command-timeout','download-failed','download-too-large'];
    await publish('failed', error instanceof Error && codes.includes(error.message) ? error.message : 'update-failed');
  } finally {
    if (temporary) await rm(temporary, {recursive:true,force:true});
    await rm(join(inbox,'request.json'), {force:true});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await execute();
