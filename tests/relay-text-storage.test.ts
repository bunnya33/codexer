import { testAccount, testAgent } from './account-helpers.js';
import { expect, it } from 'vitest';
import { RelayStore } from '../apps/relay/src/storage/store.js';
import { createRelay } from '../apps/relay/src/server.js';
import { snapshot, waitFor, WsPeer } from './helpers.js';
import { jsonForStorage } from '../packages/shared/src/json.js';

it('persists snapshots, events and catalogs with NUL and broken UTF-16 without losing literal escapes', async () => {
  const store = await RelayStore.open();
  try {
    const user = await testAccount(store), device = await testAgent(store, user.id);
    const state = snapshot(device.id);
    state.threads['thread-test']!.turns[0]!.items = [{id: 'output', type: 'commandExecution', output: 'before\0after \\u0000 \ud800', truncated: false}];
    await store.saveSnapshot(state);
    expect((await store.snapshot(device.id))!.threads['thread-test']!.turns[0]!.items[0]!.output).toBe('before\uFFFDafter \\u0000 \uFFFD');
    const thread = {...state.threads['thread-test']!, title: 'updated\0title'};
    await store.saveEvent({protocolVersion: 1, deviceId: device.id, epoch: state.epoch, seq: 1, timestamp: Date.now(), change: {type: 'thread.updated', thread}});
    expect((await store.snapshot(device.id))!.threads['thread-test']!.title).toBe('updated\uFFFDtitle');
    expect((await store.replay(device.id, state.epoch, 0))![0]!.change).toMatchObject({thread: {title: 'updated\uFFFDtitle'}});
    await store.saveCatalog({protocolVersion: 1, deviceId: device.id, generatedAt: 1, projects: [], threads: [{id: 'thread-test', title: 'catalog\0title', cwd: null, projectId: null, updatedAt: 1, archived: false}]});
    expect((await store.catalog(device.id))!.threads[0]!.title).toBe('catalog\uFFFDtitle');
    expect(JSON.parse(jsonForStorage({'nested\0key': {'__proto__': null, text: 'emoji 😀 \\u0000'}}))).toEqual({'nested\uFFFDkey': {text: 'emoji 😀 \\u0000'}});
  } finally { await store.close(); }
});

it('keeps an older agent connected when task output contains NUL and broadcasts the same text it stores', async () => {
  const store = await RelayStore.open(), user = await testAccount(store), device = await testAgent(store, user.id);
  const app = await createRelay({store});
  let agent: WsPeer | undefined, client: WsPeer | undefined;
  try {
    const base = await app.listen({host: '127.0.0.1', port: 0}), ws = base.replace('http:', 'ws:');
    agent = await WsPeer.open(ws + '/v1/ws/device', {authorization: `Bearer ${device.token}`, 'x-device-id': device.id});
    await agent.wait(message => message.type === 'device.welcome');
    agent.send({type: 'device.snapshot', snapshot: snapshot(device.id)});
    await waitFor(async () => !!await store.snapshot(device.id));
    const ticket = (await app.inject({method: 'POST', url: '/v1/ws/tickets', headers: user.headers})).json().ticket;
    client = await WsPeer.open(ws + '/v1/ws/client');
    client.send({type: 'client.authenticate', ticket}); await client.wait(message => message.type === 'client.authenticated');
    client.send({type: 'client.subscribe', deviceId: device.id}); await client.wait(message => message.type === 'sync.ready');
    const state = snapshot(device.id);
    state.lastSeq = 1;
    state.threads['thread-test']!.turns[0]!.items = [{id: 'command-output', type: 'commandExecution', output: 'first\0second', truncated: false}];
    agent.send({type: 'device.snapshot', snapshot: state});
    const broadcast = await client.wait(message => message.type === 'device.snapshot' && (message.snapshot as {lastSeq: number})?.lastSeq === 1);
    expect(broadcast.snapshot).toEqual(await store.snapshot(device.id));
    expect((await store.snapshot(device.id))!.threads['thread-test']!.turns[0]!.items[0]!.output).toBe('first\uFFFDsecond');
    await waitFor(async () => (await app.inject({url: '/v1/devices', headers: user.headers})).json().devices[0]?.online);
    expect(agent.socket.readyState).toBe(1);
  } finally { await agent?.close(); await client?.close(); await app.close(); }
});
