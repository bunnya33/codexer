import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { UpdateJob, VersionInfo } from './server-update.js';
import { newerVersion, STABLE_TAG } from './server-update.js';

export type DeploySession = { url: string; session: string; username: string; expiresAt: number; allowHttp: boolean };
export type DeployArchive = { path: string; name: string; version: string; tag: string; platform: string; size: number; sha256: string };
export type DeployReceipt = { url: string; tag: string; sha256: string; size: number; jobId: string; stage: 'uploaded' | 'restart-requested' | 'succeeded'; updatedAt: string };
export class DeployError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}
export function deployUrl(value: string, allowHttp = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new DeployError('invalid-server-url'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new DeployError('invalid-server-url');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !allowHttp) throw new DeployError('http-server-requires-allow-http');
  return url.origin;
}
export class DeployClient {
  readonly url: string;
  constructor(readonly credentials: Pick<DeploySession, 'url' | 'session' | 'allowHttp'>) { this.url = deployUrl(credentials.url, credentials.allowHttp); }
  async request<T>(path: string, options: RequestInit = {}, timeout = 30000): Promise<T> {
    let response: Response, raw: string;
    try {
      response = await fetch(new URL(path, this.url), { ...options, headers: { ...options.headers, ...(this.credentials.session ? { authorization: `Bearer ${this.credentials.session}` } : {}) }, redirect: 'error', signal: AbortSignal.timeout(timeout) });
      raw = await response.text();
    } catch { throw new DeployError('server-unreachable'); }
    if (raw.length > 1024 * 1024) throw new DeployError('invalid-server-response');
    let value: Record<string, unknown>;
    try { value = JSON.parse(raw); } catch { throw new DeployError('invalid-server-response', response.status); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DeployError('invalid-server-response', response.status);
    if (!response.ok) {
      const code = response.status === 401 ? 'login-expired' : response.status === 403 ? 'admin-required' : typeof value.error === 'string' && /^[a-z0-9-]{1,100}$/.test(value.error) ? value.error : `server-http-${response.status}`;
      throw new DeployError(code, response.status);
    }
    return value as T;
  }
  json<T>(path: string, body: unknown) { return this.request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  async assertAdmin() { if ((await this.request<{ role: string }>('/v1/me')).role !== 'admin') throw new DeployError('admin-required'); }
  async info(): Promise<VersionInfo> {
    const info = await this.request<VersionInfo>('/v1/admin/system/version');
    if (!STABLE_TAG.test('v' + info.currentVersion) || typeof info.supported !== 'boolean') throw new DeployError('invalid-version-response');
    return info;
  }
  async health(version: string) {
    const health = await this.request<{ version: string }>('/health');
    if (health.version !== version) throw new DeployError('health-version-mismatch');
    await this.assertAdmin();
  }
  upload(archive: DeployArchive) {
    const query = new URLSearchParams({ name: archive.name, sha256: archive.sha256 });
    return this.request<UpdateJob>('/v1/admin/system/update-package?' + query, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': String(archive.size) }, body: createReadStream(archive.path) as unknown as BodyInit, duplex: 'half' } as RequestInit, 10 * 60000);
  }
}
export async function loginDeployment(url: string, username: string, password: string, allowHttp = false): Promise<DeploySession> {
  const client = new DeployClient({ url, session: '', allowHttp });
  if (!username.trim() || username.length > 100 || !password || password.length > 128) throw new DeployError('invalid-login');
  const result = await client.json<{ session: string; role: string; expiresAt: number }>('/v1/admin/auth/login', { username, password });
  if (result.role !== 'admin' || typeof result.session !== 'string' || !result.session || !Number.isFinite(result.expiresAt)) throw new DeployError('invalid-login-response');
  const credentials = { url: client.url, session: result.session, username: username.trim(), expiresAt: result.expiresAt, allowHttp };
  await new DeployClient(credentials).assertAdmin();
  return credentials;
}
export async function inspectDeployArchive(path: string, checksumPath = path + '.sha256'): Promise<DeployArchive> {
  path = resolve(path);
  const name = basename(path), match = /^codexer-server-(\d+\.\d+\.\d+)-(linux|darwin)-(amd64|arm64)\.tar\.gz$/.exec(name);
  if (!match) throw new DeployError('invalid-server-package-name');
  const file = await stat(path);
  if (!file.isFile() || file.size < 128 || file.size > 256 * 1024 * 1024) throw new DeployError('invalid-server-package-size');
  if ((await stat(checksumPath)).size > 4096) throw new DeployError('invalid-checksum-file');
  const checksum = (await readFile(checksumPath, 'utf8')).trim().split(/\s+/);
  if (checksum.length !== 2 || !/^[a-f0-9]{64}$/i.test(checksum[0]!) || checksum[1]!.replace(/^\*/, '') !== name) throw new DeployError('invalid-checksum-file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  if (sha256 !== checksum[0]!.toLowerCase()) throw new DeployError('checksum-mismatch');
  return { path, name, version: match[1]!, tag: 'v' + match[1], platform: `${match[2]}-${match[3]}`, size: file.size, sha256 };
}
function sameJob(job: UpdateJob | null, receipt: DeployReceipt, archive: DeployArchive) {
  return job?.id === receipt.jobId && job.tag === archive.tag && job.method === 'upload' && job.sha256 === archive.sha256 && job.size === archive.size;
}
export type DeployOptions = {
  apply?: boolean; receipt?: DeployReceipt | null; timeoutMs?: number; pollMs?: number;
  save: (receipt: DeployReceipt) => Promise<void>; report?: (value: Record<string, unknown>) => void;
};
/** Upload and activate one exact package. Never retries a mutation or adopts an unrelated job. */
export async function deployServer(client: DeployClient, archive: DeployArchive, options: DeployOptions) {
  await client.assertAdmin();
  let info = await client.info();
  if (info.currentVersion === archive.version) { await client.health(archive.version); return { result: 'already-current', url: client.url, version: archive.version }; }
  if (!newerVersion(archive.version, info.currentVersion)) throw new DeployError('target-version-not-newer');
  if (!info.supported || !info.uploadSupported) throw new DeployError('upload-updater-not-installed');
  if (info.platform !== archive.platform) throw new DeployError('server-package-platform-mismatch');
  let receipt = options.receipt;
  const owns = receipt && receipt.url === client.url && receipt.tag === archive.tag && receipt.sha256 === archive.sha256 && receipt.size === archive.size && sameJob(info.job, receipt, archive);
  if (info.uploading || info.job && !['succeeded', 'failed', 'rolled-back'].includes(info.job.phase) && !owns) throw new DeployError('unrelated-update-in-progress');
  const plan = { url: client.url, from: info.currentVersion, to: archive.version, platform: archive.platform, name: archive.name, sha256: archive.sha256, size: archive.size, ...(owns ? { jobId: receipt!.jobId, phase: info.job?.phase } : {}) };
  if (!options.apply) return { result: 'dry-run', ...plan };
  if (owns && ['failed', 'rolled-back'].includes(info.job!.phase)) throw new DeployError('update-' + info.job!.phase + (info.job!.code ? ':' + info.job!.code : ''));
  options.report?.({ event: 'deploy', ...plan });
  await client.json('/v1/auth/active', {});
  if (!owns) {
    const job = await client.upload(archive);
    if (!job || typeof job.id !== 'string' || job.tag !== archive.tag || job.method !== 'upload' || job.sha256 !== archive.sha256 || job.size !== archive.size) throw new DeployError('invalid-upload-job');
    receipt = { url: client.url, tag: archive.tag, sha256: archive.sha256, size: archive.size, jobId: job.id, stage: 'uploaded', updatedAt: new Date().toISOString() };
    await options.save(receipt);
  }
  const ownReceipt = receipt!;
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60000), pollMs = options.pollMs ?? 3000;
  let lastPhase = '', lastTouch = Date.now();
  while (Date.now() < deadline) {
    try { info = await client.info(); }
    catch (error) {
      if (!(error instanceof DeployError) || error.code !== 'server-unreachable' && !(error.status && error.status >= 500)) throw error;
      options.report?.({ event: 'waiting-for-server', jobId: ownReceipt.jobId });
      await new Promise(resolveWait => setTimeout(resolveWait, pollMs)); continue;
    }
    if (!sameJob(info.job, ownReceipt, archive)) throw new DeployError('deployment-job-changed');
    const job = info.job!;
    if (job.phase !== lastPhase) { options.report?.({ event: 'job', jobId: job.id, phase: job.phase, action: job.action, code: job.code }); lastPhase = job.phase; }
    if (job.phase === 'failed' || job.phase === 'rolled-back') throw new DeployError('update-' + job.phase + (job.code ? ':' + job.code : ''));
    if (job.phase === 'succeeded') {
      if (info.currentVersion !== archive.version) throw new DeployError('installed-version-mismatch');
      await client.health(archive.version);
      ownReceipt.stage = 'succeeded'; ownReceipt.updatedAt = new Date().toISOString(); await options.save(ownReceipt);
      return { result: 'succeeded', url: client.url, version: archive.version, jobId: job.id, sha256: archive.sha256 };
    }
    if (job.phase === 'built' && ownReceipt.stage === 'uploaded') {
      ownReceipt.stage = 'restart-requested'; ownReceipt.updatedAt = new Date().toISOString();
      await options.save(ownReceipt);
      try { await client.json('/v1/admin/system/update', { tag: archive.tag, action: 'restart', jobId: ownReceipt.jobId }); }
      catch (error) { if (!(error instanceof DeployError) || error.code !== 'server-unreachable' && !(error.status && error.status >= 500)) throw error; }
    }
    if (Date.now() - lastTouch >= 30000) { await client.json('/v1/auth/active', {}); lastTouch = Date.now(); }
    await new Promise(resolveWait => setTimeout(resolveWait, pollMs));
  }
  throw new DeployError('deployment-timeout-check-status-before-retry');
}
