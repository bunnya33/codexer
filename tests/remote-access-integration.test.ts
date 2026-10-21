import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {PcAgent} from '../apps/pc-agent/src/agent.js';
import {loginAgent} from '../apps/pc-agent/src/auth.js';
import {permissionPreset} from '../packages/codex-adapter/src/permissions.js';
import {record} from '../packages/codex-adapter/src/normalize.js';
import {createRelay, RelayStore} from './go-relay.js';
import {command, FakeDesktop, rawThread, waitFor} from './helpers.js';
import {testAccount, testPassword} from './account-helpers.js';

it('routes site and app approvals and permission changes through real Go Relay and PC Agent without replay or cross-account control', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-remote-access-')), desktop = new FakeDesktop();
  const store = await RelayStore.open(), account = await testAccount(store), other = await testAccount(store, 'other'), app = await createRelay({store});
  let agent: PcAgent | undefined;
  try {
    const params = (id: number) => ({id, method: 'mcpServer/elicitation/request', params: {threadId: 'thread-test', turnId: 'turn-A', mode: 'form', requestedSchema: {type: 'object', properties: {}}, message: 'Test access', ...(id === 42 ? {serverName: 'browser-use', _meta: {origin: 'http://localhost:5173', persist: 'always'}} : {serverName: 'cua_repl', _meta: {codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', tool_name: 'get_app', tool_params: {app: 'Fixture'}, persist: ['session', 'always']}})}});
    desktop.state = {...rawThread(), requests: [params(42), params(43)]};
    await desktop.start(); const base = await app.listen({host: '127.0.0.1', port: 0});
    const credentials = await loginAgent(base, join(directory, 'session'), account.name, testPassword);
    const reader = {list: async () => ({protocolVersion: 1 as const, deviceId: credentials.deviceId, generatedAt: Date.now(), projects: [], threads: []}), history: async () => {throw new Error('unused');}};
    agent = new PcAgent(credentials, directory, ['thread-test'], desktop.endpoint, join(directory, 'empty'), 'desktop', reader);
    await agent.start(); await waitFor(() => !!agent!.snapshot().threads['thread-test']?.ownerAvailable && agent!.status().relayConnected);
    await waitFor(async () => !!(await store.snapshot(credentials.deviceId))?.threads['thread-test']?.ownerAvailable);
    const submit = (payload: Parameters<typeof command>[0], headers = account.headers) => app.inject({method: 'POST', url: `/v1/devices/${credentials.deviceId}/commands`, headers, payload: command(payload, agent!.snapshot())});
    const execute = async (payload: Parameters<typeof command>[0]) => {
      const input = command(payload, agent!.snapshot());
      const response = await app.inject({method: 'POST', url: `/v1/devices/${credentials.deviceId}/commands`, headers: account.headers, payload: input});
      expect(response.statusCode).toBe(200);
      await waitFor(async () => !!(await store.command(credentials.deviceId, input.commandId))?.result);
      return (await store.command(credentials.deviceId, input.commandId))!.result;
    };
    const approval = {type: 'elicitation.respond' as const, threadId: 'thread-test', turnId: 'turn-A', requestId: '42', decision: 'accept' as const, scope: 'always' as const};
    expect((await submit(approval, other.headers)).statusCode).toBe(404);
    expect(await execute(approval)).toMatchObject({status: 'succeeded'});
    expect(await execute(approval)).toMatchObject({status: 'failed', code: 'stale-request'});
    expect(await execute({...approval, requestId: '43', scope: 'session'})).toMatchObject({status: 'succeeded'});
    const replies = desktop.received.filter(m => m.method === 'thread-follower-submit-mcp-server-elicitation-response');
    expect(replies.map(m => record(m.params).response)).toEqual([{action: 'accept', content: {}, _meta: {persist: 'always'}}, {action: 'accept', content: {}, _meta: {persist: 'session'}}]);
    desktop.state = {...rawThread('idle'), latestThreadSettings: {...permissionPreset('ask', ['/test']), model: 'original-model', effort: 'high'}};
    desktop.publishSnapshot(); await waitFor(() => agent!.snapshot().threads['thread-test']?.settings?.permissions?.mode === 'ask');
    desktop.response = message => {
      if (message.method === 'thread-follower-update-thread-settings') {
        desktop.state.latestThreadSettings = {...record(desktop.state.latestThreadSettings), ...record(record(message.params).threadSettings)};
        desktop.publishSnapshot(); return {applied: true};
      }
    };
    const change = {type: 'thread.permissions.update' as const, threadId: 'thread-test', mode: 'full-access' as const, expectedPermissions: agent.snapshot().threads['thread-test']!.settings!.permissions!.fingerprint};
    expect(await execute(change)).toMatchObject({status: 'succeeded', result: {permissions: {mode: 'full-access'}}});
    expect(await execute(change)).toMatchObject({status: 'failed', code: 'stale-permissions'});
  } finally {await agent?.stop(); await app.close(); await desktop.close(); await rm(directory, {recursive: true, force: true});}
});
