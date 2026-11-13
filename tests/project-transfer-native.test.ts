import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRelay, RelayStore } from './go-relay';
import { testAccount, testAgent } from './account-helpers';
import { snapshot, waitFor, WsPeer } from './helpers';
import type { ProjectTransfer } from '../packages/protocol/src/project-transfers';

const native = resolve('apps/agent-qt/build', process.platform === 'win32' ? 'Release/CodexerNativeTests.exe' : 'CodexerNativeTests');
it.skipIf(!existsSync(native))('transfers an unpushed project through the real Relay using two native workers and recovers a received project after a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-transfer-'));
  const store = await RelayStore.open(), account = await testAccount(store);
  const source = await testAgent(store, account.id), target = await testAgent(store, account.id);
  const app = await createRelay({store}); const peers: WsPeer[] = [];
  const root = join(directory, 'source'), parent = join(directory, 'target');
  await mkdir(root); await mkdir(parent);
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 19); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await writeFile(join(root, 'untracked.bin'), bytes); await writeFile(join(root, 'code.ts'), 'unfinished work\n');
  await writeFile(join(root, '.env'), 'PRIVATE=local'); await mkdir(join(root, 'empty'));
  try {
    const url = await app.listen({host: '127.0.0.1', port: 0});
    for (const agent of [source, target]) {
      const peer = await WsPeer.open(url.replace('http:', 'ws:') + '/v1/ws/device', {authorization: 'Bearer ' + agent.token, 'x-device-id': agent.id}); peers.push(peer);
      await peer.wait(m => m.type === 'device.welcome');
      peer.send({type: 'device.snapshot', snapshot: snapshot(agent.id)});
      peer.send({type: 'device.catalog', catalog: {protocolVersion: 1, deviceId: agent.id, generatedAt: Date.now(), projectTransfer: true,
        projects: agent === source ? [{id: 'project', name: 'Unpushed', roots: [root], position: 0, updatedAt: 1}] : [], threads: [],
        projectCreation: {parents: agent === target ? [{id: 'parent', path: parent.replaceAll('\\', '/')}] : []}}});
    }
    await waitFor(async () => !!(await store.catalog(source.id)) && !!(await store.catalog(target.id)));
    const create = {id: randomUUID(), sourceDeviceId: source.id, targetDeviceId: target.id, projectId: 'project', parentId: 'parent', relativePath: 'received',
      options: {includeGit: true, includeLocalFiles: false, excludedDirectories: ['node_modules'], note: 'Receive now; develop later'}};
    const result = await app.inject({method: 'POST', url: '/v1/project-transfers', headers: account.headers, payload: create});
    expect(result.statusCode).toBe(200);
    const get = async () => (await app.inject({url: '/v1/project-transfers', headers: account.headers})).json().transfers[0] as ProjectTransfer;
    const runWorker = async (agent: typeof source, job: ProjectTransfer) => {
      const config = join(directory, agent.id + '.json'), output = join(directory, agent.id + '-result.json');
      await writeFile(config, JSON.stringify({credentials: {deviceId: agent.id, session: agent.token, relayUrl: url}, job, cache: join(directory, 'cache-' + agent.id), roots: agent === source ? [root] : []}));
      const qt = process.env.CODEXER_QT_ROOT ?? resolve('.local/qt/6.8.3', process.platform === 'win32' ? 'msvc2022_64' : 'macos');
      await new Promise<void>((done, fail) => {
        const child = spawn(native, ['--project-transfer-worker', config, output], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PATH: join(qt, 'bin') + delimiter + process.env.PATH, QT_PLUGIN_PATH: join(qt, 'plugins')}});
        let error = ''; child.stderr.on('data', b => {error += b;}); child.on('error', fail); child.on('exit', code => code === 0 ? done() : fail(new Error(`Native worker ${code}: ${error}`)));
      });
      const outcome = JSON.parse(await readFile(output, 'utf8')); expect(outcome.code).toBeUndefined(); return outcome;
    };
    await runWorker(source, await get());
    let job = await get(); expect(job.state).toBe('ready'); expect(job.excludedSamples).toContain('.env');
    expect(job.preparation?.phase).toBe('checksumming');
    expect(existsSync(join(parent, 'received'))).toBe(false);
    await app.inject({method: 'POST', url: `/v1/project-transfers/${create.id}/start`, headers: account.headers, payload: {}});
    await runWorker(source, await get()); job = await get(); expect(job.state).toBe('downloading');
    // A previous receiver stopped after a partial download. Resume this file.
    const targetCache = join(directory, 'cache-' + target.id); await mkdir(targetCache);
    const chunk = await fetch(url + `/v1/agent/${target.id}/project-transfers/${create.id}/chunk?offset=0`, {headers: {authorization: 'Bearer ' + target.token, 'x-device-id': target.id}});
    expect(chunk.status).toBe(200); await writeFile(join(targetCache, 'in.snapshot'), Buffer.from(await chunk.arrayBuffer()));
    const outcome = await runWorker(target, job);
    job = await get(); expect(job.state).toBe('received');
    expect(await readFile(join(parent, 'received/untracked.bin'))).toEqual(bytes);
    expect(await readFile(join(parent, 'received/code.ts'), 'utf8')).toBe('unfinished work\n');
    expect(existsSync(join(parent, 'received/empty'))).toBe(true); expect(existsSync(join(parent, 'received/.env'))).toBe(false);
    expect(outcome.savedPath.replaceAll('\\', '/')).toBe(join(parent, 'received').replaceAll('\\', '/'));
    // Restart after rename and before registration: validate the receipt and
    // adopt the same directory, without overwriting or launching a model turn.
    expect((await runWorker(target, job)).savedPath).toBe(outcome.savedPath);
    expect((await get()).state).toBe('received');
    expect(existsSync(join(root, 'untracked.bin'))).toBe(true);
  } finally {for (const peer of peers) peer.close(); await app.close(); await rm(directory, {recursive: true, force: true});}
}, 60000);
