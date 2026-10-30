import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {afterEach, expect, it, vi} from 'vitest';
import {PcAgent} from '../apps/pc-agent/src/agent.js';
import {AdapterError} from '../packages/codex-adapter/src/desktop.js';
import {normalizeThread} from '../packages/codex-adapter/src/normalize.js';
import {command} from './helpers.js';
const agents: PcAgent[] = [], directories: string[] = [];
afterEach(async () => {for (const agent of agents.splice(0)) await agent.stop(); for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});});
async function fixture(preference: 'auto' | 'headless' = 'auto') {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-handoff-')); directories.push(directory);
  const agent = new PcAgent({relayUrl: 'https://relay.example.test', session: 'synthetic', deviceId: randomUUID(), expiresAt: Date.now() + 60000, installationId: randomUUID(), username: 'synthetic'}, directory, [], undefined, directory, preference); agents.push(agent);
  const internals = agent as any;
  internals.headlessThreads.add('thread-test');
  const headless = vi.spyOn(internals.headless, 'execute').mockRejectedValue(new AdapterError('thread-writer-busy'));
  const desktop = vi.spyOn(agent.adapter, 'execute').mockResolvedValue({turnId: 'desktop-turn'});
  const follow = vi.spyOn(agent.adapter, 'follow').mockResolvedValue(true);
  const thread = normalizeThread({id: 'thread-test', threadRuntimeStatus: {type: 'idle'}, turns: []}, 0);
  vi.spyOn(agent.adapter, 'getThread').mockReturnValue(thread);
  agent.adapter.connected = true;
  return {agent, internals, desktop, headless, follow};
}
it('rediscovers the desktop owner after a definite rejected resume, sending the message exactly once there', async () => {
  const {internals, desktop, headless, follow} = await fixture();
  const request = command({type: 'turn.start', threadId: 'thread-test', text: 'synthetic input'});
  await expect(internals.executeWithHandoff(request, [])).resolves.toEqual({turnId: 'desktop-turn'});
  expect(headless).toHaveBeenCalledOnce(); expect(follow).toHaveBeenCalledWith('thread-test'); expect(desktop).toHaveBeenCalledExactlyOnceWith(request, []); expect(internals.headlessThreads.has('thread-test')).toBe(false);
});
it.each(['uncertain', 'timeout', 'headless-only', 'unavailable', 'paused', 'expired'])('does not resend when %s prevents a verified handoff', async kind => {
  const {agent, internals, desktop, headless, follow} = await fixture(kind === 'headless-only' ? 'headless' : 'auto');
  if (kind === 'uncertain') headless.mockRejectedValue(new AdapterError('thread-writer-busy', true));
  if (kind === 'timeout') headless.mockRejectedValue(new AdapterError('turn/start-timeout', true));
  if (kind === 'unavailable') follow.mockResolvedValue(false);
  if (kind === 'paused') internals.remotePaused = true;
  const request = command({type: 'turn.start', threadId: 'thread-test', text: 'synthetic input'});
  if (kind === 'expired') request.expiresAt = Date.now() - 1;
  await expect(internals.executeWithHandoff(request, [])).rejects.toBeInstanceOf(AdapterError); expect(desktop).not.toHaveBeenCalled();
});
