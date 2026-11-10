import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { DeployClient, deployServer, deployUrl, inspectDeployArchive } from '../packages/shared/src/server-deploy.js';
import type { DeployReceipt } from '../packages/shared/src/server-deploy.js';
import {savePublishingCredential} from '../packages/shared/src/publisher-auth.js';
import { readSecret, writeSecret } from '../packages/shared/src/secrets.js';
import type { UpdateJob } from '../packages/shared/src/server-update.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const token = 'cdxp_a_'+'A'.repeat(43);
async function archiveFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-deploy-test-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'codexer-server-0.3.54-linux-amd64.tar.gz'), bytes = Buffer.alloc(512, 7);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path, bytes); await writeFile(path + '.sha256', sha256 + '  ' + path.split(/[\\/]/).at(-1) + '\n');
  return { directory, path, bytes, archive: await inspectDeployArchive(path) };
}
async function remoteFixture(options: { dropRestart?: boolean; fail?: 'failed' | 'rolled-back'; stayBuilt?: boolean; role?: string; authStatus?: number; redirect?: string } = {}) {
  let version = '0.3.53', job: UpdateJob | null = null, reads = 0;
  const requests: { method: string; path: string; authorization?: string }[] = [], uploads: Buffer[] = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    requests.push({ method: req.method!, path, authorization: req.headers.authorization });
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (path === '/v1/admin/auth/login') {
      let body = ''; for await (const chunk of req) body += chunk;
      const credentials = JSON.parse(body);
      return credentials.username === 'admin' && credentials.password === 'synthetic-password'
        ? json(200, { session: token, role: options.role ?? 'admin', expiresAt: Date.now() + 60000 }) : json(401, { error: 'invalid-credentials' });
    }
    if (options.redirect) { res.writeHead(302, { location: options.redirect }); res.end(); return; }
    if (path === '/health') return json(200, { version });
    if (options.authStatus || req.headers.authorization !== 'Bearer ' + token) return json(options.authStatus ?? 401, { error: 'unauthorized' });
    if (path === '/v1/publish/me') return json(200, options.role==='user'?{}:{grantId:'synthetic-grant',scopes:['server:read','server:write']});
    if (path === '/v1/auth/active') return json(200, { expiresAt: Date.now() + 60000 });
    if (path === '/v1/publish/revoke') return json(200, { loggedOut: true });
    if (path === '/v1/admin/system/version') {
      if (job && ++reads >= 2) {
        if (job.action === 'restart' && !options.stayBuilt) { job.phase = options.fail ?? 'succeeded'; if (job.phase === 'succeeded') version = '0.3.54'; }
        else job.phase = options.fail ?? 'built';
      }
      return json(200, { currentVersion: version, platform: 'linux-amd64', supported: true, uploadSupported: true, uploading: false, job });
    }
    if (path === '/v1/admin/system/update-package') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks); uploads.push(bytes);
      const query = new URL(req.url!, 'http://localhost').searchParams;
      if (createHash('sha256').update(bytes).digest('hex') !== query.get('sha256')) return json(400, { error: 'checksum-mismatch' });
      job = { id: '55555555-5555-4555-8555-555555555555', tag: 'v0.3.54', method: 'upload', source: 'upload', action: 'update', phase: 'queued', updatedAt: Date.now(), sha256: query.get('sha256')!, size: bytes.length }; reads = 0;
      return json(200, job);
    }
    if (path === '/v1/admin/system/update') {
      let body = ''; for await (const chunk of req) body += chunk;
      const value = JSON.parse(body);
      if (!job || value.jobId !== job.id || value.tag !== job.tag || value.action !== 'restart') return json(409, { error: 'update-step-not-ready' });
      job = { ...job, action: 'restart', phase: options.stayBuilt ? 'built' : 'queued' }; reads = 0;
      if (options.dropRestart) { req.socket.destroy(); return; }
      return json(200, job);
    }
    json(404, { error: 'not-found' });
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  cleanups.push(() => new Promise<void>(resolveClose => { server.close(() => resolveClose()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('listen-failed');
  const url = `http://127.0.0.1:${address.port}`, client = new DeployClient({ url, session: token, allowHttp: false, publishing: true });
  return { url, client, requests, uploads, setJob: (value: UpdateJob | null) => { job = value; }, setVersion: (value: string) => { version = value; } };
}

it('validates the package locally and performs a read-only preflight', async () => {
  const a = await archiveFixture(), remote = await remoteFixture(), saved: DeployReceipt[] = [];
  expect(await deployServer(remote.client, a.archive, { save: async receipt => { saved.push(receipt); } })).toMatchObject({ result: 'dry-run', from: '0.3.53', to: '0.3.54', sha256: a.archive.sha256 });
  expect(remote.requests.every(request => request.method === 'GET')).toBe(true);
  expect(saved).toEqual([]); expect(remote.uploads).toEqual([]);
});
it.each([false, true])('uploads original bytes, restarts once and verifies the final version (lost restart response: %s)', async dropRestart => {
  const a = await archiveFixture(), remote = await remoteFixture({ dropRestart }), saved: DeployReceipt[] = [];
  expect(await deployServer(remote.client, a.archive, { apply: true, pollMs: 1, save: async receipt => { saved.push({ ...receipt }); } })).toMatchObject({ result: 'succeeded', version: '0.3.54' });
  expect(remote.uploads).toEqual([a.bytes]);
  expect(saved.map(receipt => receipt.stage)).toEqual(['uploaded', 'restart-requested', 'succeeded']);
  expect(remote.requests.filter(request => request.path === '/v1/admin/system/update')).toHaveLength(1);
  expect(remote.requests.some(request => request.path === '/health')).toBe(true);
});
it.each(['failed', 'rolled-back'] as const)('stops when preparation ends as %s', async fail => {
  const a = await archiveFixture(), remote = await remoteFixture({ fail });
  await expect(deployServer(remote.client, a.archive, { apply: true, pollMs: 1, save: async () => {} })).rejects.toThrow('update-' + fail);
  expect(remote.requests.filter(request => request.path === '/v1/admin/system/update')).toHaveLength(0);
});
it('refuses an existing job even if its target and bytes match without a local receipt', async () => {
  const a = await archiveFixture(), remote = await remoteFixture();
  remote.setJob({ id: 'another-job', tag: a.archive.tag, method: 'upload', phase: 'built', sha256: a.archive.sha256, size: a.archive.size, updatedAt: 1 });
  await expect(deployServer(remote.client, a.archive, { apply: true, save: async () => {} })).rejects.toThrow('unrelated-update-in-progress');
  expect(remote.requests.every(request => request.method === 'GET')).toBe(true);
});
it('resumes only its exact recorded job without uploading again', async () => {
  const a = await archiveFixture(), remote = await remoteFixture();
  const receipt: DeployReceipt = { url: remote.url, tag: a.archive.tag, sha256: a.archive.sha256, size: a.archive.size, jobId: 'own-job', stage: 'uploaded', updatedAt: '' };
  remote.setJob({ id: receipt.jobId, tag: receipt.tag, method: 'upload', phase: 'built', sha256: receipt.sha256, size: receipt.size, updatedAt: 1 });
  expect(await deployServer(remote.client, a.archive, { apply: true, receipt, pollMs: 1, save: async () => {} })).toMatchObject({ result: 'succeeded' });
  expect(remote.uploads).toEqual([]);
});
it('does not repeatedly restart a task that remains built after the request', async () => {
  const a = await archiveFixture(), remote = await remoteFixture({ stayBuilt: true });
  await expect(deployServer(remote.client, a.archive, { apply: true, pollMs: 1, timeoutMs: 100, save: async () => {} })).rejects.toThrow('deployment-timeout');
  expect(remote.requests.filter(request => request.path === '/v1/admin/system/update')).toHaveLength(1);
});
it('refuses checksum, platform and version mismatches before mutations', async () => {
  const a = await archiveFixture(), remote = await remoteFixture();
  await writeFile(a.path, Buffer.alloc(512, 8));
  await expect(inspectDeployArchive(a.path)).rejects.toThrow('checksum-mismatch');
  await expect(deployServer(remote.client, { ...a.archive, platform: 'linux-arm64' }, { apply: true, save: async () => {} })).rejects.toThrow('server-package-platform-mismatch');
  remote.setVersion('0.3.55');
  await expect(deployServer(remote.client, a.archive, { apply: true, save: async () => {} })).rejects.toThrow('target-version-not-newer');
  expect(remote.requests.every(request => request.method === 'GET')).toBe(true);
});
it('checks health and admin access even when the target version is already installed', async () => {
  const a = await archiveFixture(), remote = await remoteFixture(); remote.setVersion(a.archive.version);
  expect(await deployServer(remote.client, a.archive, { apply: true, save: async () => {} })).toMatchObject({ result: 'already-current' });
  expect(remote.requests.every(request => request.method === 'GET')).toBe(true);
  expect(remote.requests.filter(request => request.path === '/v1/publish/me')).toHaveLength(2);
});
it.each([401, 403])('rejects invalid administrator access (%s)', async authStatus => {
  const a = await archiveFixture(), remote = await remoteFixture({ authStatus });
  await expect(deployServer(remote.client, a.archive, { apply: true, save: async () => {} })).rejects.toThrow(authStatus === 401 ? 'login-expired' : 'unauthorized');
  expect(remote.uploads).toEqual([]);
});
it('rejects a role mismatch and does not follow a credential-bearing redirect', async () => {
  const user = await remoteFixture({ role: 'user' });
  await expect(user.client.assertAdmin()).rejects.toThrow('invalid-publishing-identity');
  const destination = await remoteFixture(), redirect = await remoteFixture({ redirect: destination.url + '/v1/me' });
  await expect(redirect.client.assertAdmin()).rejects.toThrow('server-unreachable'); expect(destination.requests).toEqual([]);
  expect(() => deployUrl('https://user:password@example.test')).toThrow('invalid-server-url');
  expect(() => deployUrl('http://example.test')).toThrow('allow-http');
});
it.skipIf(process.platform!=='win32')('runs CLI preflight, deployment and logout with an isolated saved login and no credential output', async () => {
  const a = await archiveFixture(), remote = await remoteFixture();
  const session = {format:'publishing-v1' as const,url:remote.url,accessToken:token,refreshToken:'cdxp_r_'+ 'B'.repeat(43),expiresAt:Date.now()+600000,refreshExpiresAt:Date.now()+86400000,grantExpiresAt:Date.now()+86400000,grantId:'synthetic-grant',username:'admin',scopes:['server:read','server:write']};
  await savePublishingCredential(join(a.directory, 'default.secret'), session);
  const run = async (...args: string[]) => (await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/server-deploy.ts', ...args], { env: { ...process.env, CODEXER_DEPLOY_HOME: a.directory }, windowsHide: true })).stdout;
  const status = await run('status');
  expect(JSON.parse(status)).toMatchObject({ url: remote.url, username: 'admin', currentVersion: '0.3.53' });
  expect(status).not.toContain(token);
  remote.requests.length = 0;
  const plan = await run('deploy', '--archive', a.path);
  expect(JSON.parse(plan)).toMatchObject({ result: 'dry-run', to: '0.3.54' });
  expect(plan).not.toContain(token); expect(remote.requests.every(request => request.method === 'GET')).toBe(true);
  const installed = await run('deploy', '--archive', a.path, '--apply');
  expect(installed).not.toContain(token);
  expect(JSON.parse(installed.trim().split('\n').at(-1)!)).toMatchObject({ result: 'succeeded', version: '0.3.54' });
  const receipt = await readFile(join(a.directory, 'default.job.json'), 'utf8');
  expect(JSON.parse(receipt)).toMatchObject({ stage: 'succeeded', tag: 'v0.3.54', sha256: a.archive.sha256 }); expect(receipt).not.toContain(token);
  expect(JSON.parse(await run('deploy', '--archive', a.path, '--apply'))).toMatchObject({ result: 'already-current' });
  expect(remote.uploads).toHaveLength(1);
  expect(await run('logout')).toContain('logged-out');
  await expect(readFile(join(a.directory, 'default.secret'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 25000);
