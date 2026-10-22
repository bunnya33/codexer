import {afterEach, describe, expect, it, vi} from 'vitest';
import {DesktopAdapter} from '../packages/codex-adapter/src/desktop';
import {HeadlessAdapter} from '../packages/codex-adapter/src/headless';
import {mcpApproval, mcpApprovalResponse} from '../packages/codex-adapter/src/mcp-approvals';
import {permissionPreset, permissionSettings} from '../packages/codex-adapter/src/permissions';
import {normalizeThread, record} from '../packages/codex-adapter/src/normalize';
import {commandSchema} from '../packages/protocol/src/index';
import {command, FakeDesktop, rawThread, waitFor} from './helpers';

export const browserApproval = (turnId: string | null = 'turn-A') => ({threadId: 'thread-test', turnId, serverName: 'browser-use', mode: 'form', message: 'Access local preview', requestedSchema: {type: 'object', properties: {}}, _meta: {origin: 'http://localhost:5173', persist: 'always'}});
export const computerApproval = () => ({...browserApproval(), serverName: 'cua_repl', message: 'Use the app to verify the layout', _meta: {codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', tool_name: 'get_app', tool_params: {app: 'com.example.Fixture'}, tool_params_display: [{name: 'app', value: 'Fixture App'}], persist: ['session', 'always']}});
const request = (params: Record<string, unknown>, id = 42) => ({id, method: 'mcpServer/elicitation/request', params});

describe('remote access approval boundaries', () => {
  it('distinguishes unrestricted file access from disabled command approvals', () => {
    const preset = permissionPreset('full-access', ['/fixture']);
    expect(permissionSettings(preset)?.mode).toBe('full-access');
    expect(permissionSettings({...preset, approvalPolicy: 'on-request'})?.mode).toBe('custom');
    expect(permissionSettings({...preset, approvalPolicy: 'on-request'})?.fingerprint).not.toBe(permissionSettings(preset)?.fingerprint);
    expect(permissionSettings({...preset, sandboxPolicy: {type: 'readOnly'}})?.mode).toBe('custom');
    expect(permissionSettings({approvalPolicy: 'never'})).toBeUndefined();
  });
  it('normalizes only known empty access forms without exposing raw metadata', () => {
    const state = {...rawThread(), requests: [request(browserApproval()), request(computerApproval(), 43)]};
    const normalized = normalizeThread(state, 0);
    expect(normalized.requests).toMatchObject([{respondable: true, approval: {kind: 'browser', target: 'http://localhost:5173', scopes: ['once', 'always']}}, {respondable: true, approval: {kind: 'computer', target: 'Fixture App', scopes: ['once', 'session', 'always']}}]);
    expect(JSON.stringify(normalized.requests)).not.toContain('tool_params');
    expect(mcpApprovalResponse(computerApproval(), 'accept', 'session')).toEqual({action: 'accept', content: {}, _meta: {persist: 'session'}});
    expect(mcpApprovalResponse(browserApproval(), 'decline', 'once')).toEqual({action: 'decline', content: null, _meta: null});
  });
  it('rejects unknown scopes, nonempty forms, login challenges and execution-bound requests', () => {
    expect(() => mcpApprovalResponse(browserApproval(), 'accept', 'session')).toThrow('approval-scope-not-available');
    expect(() => mcpApprovalResponse(computerApproval(), 'decline', 'always')).toThrow();
    for (const params of [
      {...browserApproval(), mode: 'url', url: 'https://example.com/login'},
      {...browserApproval(), requestedSchema: {type: 'object', properties: {secret: {type: 'string'}}}},
      {...computerApproval(), _meta: {...computerApproval()._meta, executionBound: true}},
      {...computerApproval(), _meta: {...computerApproval()._meta, 'openai/approval': {token: 'signed'}}},
      {...browserApproval(), _meta: {origin: 'http://user:password@localhost:5173', persist: 'always'}},
      {...browserApproval(), message: 'x'.repeat(8193)},
      {...computerApproval(), _meta: {...computerApproval()._meta, tool_params_display: [{name: 'app', value: 'x'.repeat(1001)}]}},
    ]) expect(mcpApproval(params)).toBeUndefined();
    expect(commandSchema.safeParse(command({type: 'elicitation.respond', threadId: 'thread-test', turnId: null, requestId: '42', decision: 'accept', scope: 'all-sites' as never})).success).toBe(false);
  });
});

describe('official desktop permission routing', () => {
  let desktop: FakeDesktop | undefined, adapter: DesktopAdapter | undefined;
  afterEach(async () => {adapter?.stop(); await desktop?.close();});
  async function start(state = rawThread()) {
    desktop = new FakeDesktop(); desktop.state = state; await desktop.start();
    adapter = new DesktopAdapter(desktop.endpoint); await adapter.connect(); await adapter.follow('thread-test');
    await waitFor(() => !!adapter?.getThread('thread-test'));
    return {desktop, adapter};
  }
  it.each([['browser', browserApproval(), 'always'], ['computer', computerApproval(), 'session'], ['standalone', browserApproval(null), 'once']] as const)('returns %s decisions to the owner with the original request id', async (_kind, params, scope) => {
    const {desktop, adapter} = await start({...rawThread(), requests: [request(params)]});
    const payload = {type: 'elicitation.respond' as const, threadId: 'thread-test', requestId: '42', turnId: params.turnId, decision: 'accept' as const, scope};
    await expect(adapter.execute(command(payload))).resolves.toMatchObject({acknowledgedByDesktop: true});
    const message = desktop.received.find(m => m.method === 'thread-follower-submit-mcp-server-elicitation-response')!;
    expect(message).toMatchObject({targetClientId: desktop.ownerId, version: 1, params: {conversationId: 'thread-test', requestId: 42, response: mcpApprovalResponse(params, 'accept', scope)}});
    await expect(adapter.execute(command(payload))).rejects.toMatchObject({code: 'stale-request'});
  });
  it('rejects stale, completed and unsupported approvals before sending anything', async () => {
    const {desktop, adapter} = await start({...rawThread(), requests: [request(browserApproval()), {...request(computerApproval(), 43), completed: true}]});
    const payload = {type: 'elicitation.respond' as const, threadId: 'thread-test', requestId: '42', turnId: 'turn-A', decision: 'accept' as const, scope: 'session' as const};
    await expect(adapter.execute(command(payload))).rejects.toMatchObject({code: 'approval-scope-not-available'});
    await expect(adapter.execute(command({...payload, requestId: '43'}))).rejects.toMatchObject({code: 'stale-request'});
    await expect(adapter.execute(command({...payload, turnId: 'old-turn'}))).rejects.toMatchObject({code: 'stale-request'});
    expect(desktop.received.filter(m => m.method === 'thread-follower-submit-mcp-server-elicitation-response')).toEqual([]);
  });
  it('updates permissions only and confirms the authoritative streamed settings', async () => {
    const initial = {...permissionPreset('ask', ['/test']), model: 'original-model', effort: 'high'};
    const {desktop, adapter} = await start({...rawThread('idle'), latestThreadSettings: initial});
    const before = adapter.getThread('thread-test')!.settings!.permissions!;
    desktop.response = message => {
      if (message.method === 'thread-follower-update-thread-settings') {
        desktop.state.latestThreadSettings = {...initial, ...record(record(message.params).threadSettings)};
        desktop.publishSnapshot(); return {applied: true};
      }
    };
    await expect(adapter.execute(command({type: 'thread.permissions.update', threadId: 'thread-test', mode: 'full-access', expectedPermissions: before.fingerprint}))).resolves.toMatchObject({permissions: {mode: 'full-access'}});
    expect(adapter.getThread('thread-test')!.settings).toMatchObject({model: 'original-model', reasoningEffort: 'high', permissions: {sandbox: 'dangerFullAccess', approval: 'never', reviewer: 'user'}});
    const update = record(desktop.received.find(m => m.method === 'thread-follower-update-thread-settings')!.params);
    expect(record(update.threadSettings).model).toBeUndefined();
    await expect(adapter.execute(command({type: 'thread.permissions.update', threadId: 'thread-test', mode: 'ask', expectedPermissions: before.fingerprint}))).rejects.toMatchObject({code: 'stale-permissions'});
  });
});

it('answers headless MCP approvals only for the exact pending thread and request', async () => {
  const adapter = new HeadlessAdapter(), params = computerApproval();
  adapter.watched.set('thread-test', normalizeThread({...rawThread(), requests: [request(params)]}, 0));
  const respond = vi.fn();
  Object.assign(adapter, {connected: true, rpc: {respond, stop: async () => {}}, requests: new Map([['42', request(params)]])});
  vi.spyOn(adapter, 'follow').mockResolvedValue(true);
  const payload = {type: 'elicitation.respond' as const, threadId: 'thread-test', turnId: 'turn-A', requestId: '42', decision: 'accept' as const, scope: 'session' as const};
  try {
    await expect(adapter.execute(command({...payload, turnId: 'other'}))).rejects.toMatchObject({code: 'stale-request'});
    await expect(adapter.execute(command(payload))).resolves.toMatchObject({acknowledgedByAppServer: true});
    expect(respond).toHaveBeenCalledWith(42, {action: 'accept', content: {}, _meta: {persist: 'session'}});
    await expect(adapter.execute(command(payload))).rejects.toMatchObject({code: 'stale-request'});
  } finally {await adapter.stop();}
});
