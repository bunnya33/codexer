import { PcAgent } from '../../pc-agent/src/agent.js';
import type { AgentCredentials } from '../../pc-agent/src/auth.js';
import type { Settings } from './types.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCodexBinary } from '../../../packages/codex-adapter/src/binary.js';
const port = process.parentPort!;
let agent: PcAgent | null = null;
let remotePaused = true;
const send = (value: unknown) => port.postMessage(value);
port.on('message', async ({ data }: { data: { id: number; action: string; credentials: AgentCredentials; settings: Settings; directory: string } }) => {
  try {
    if (data.action === 'start') {
      if (agent) throw new Error('already-started');
      remotePaused = false;
      const { settings } = data;
      process.env.CODEX_HOME = settings.codexHome;
      process.env.CODEX_REMOTE_ALLOW_HTTP = settings.allowHttp ? '1' : '0';
      if (settings.codexBinary) process.env.CODEX_REMOTE_CODEX_BIN = settings.codexBinary;
      try { process.env.CODEX_REMOTE_CODEX_BIN = await resolveCodexBinary(settings.codexBinary || undefined); send({ type: 'diagnostic', code: 'codex-binary-found' }); }
      catch { send({ type: 'diagnostic', code: 'codex-binary-not-found' }); }
      await mkdir(data.directory, { recursive: true });
      agent = new PcAgent(data.credentials, join(data.directory, data.credentials.deviceId), process.env.CODEX_THREAD_ID ? [process.env.CODEX_THREAD_ID] : [], process.env.CODEX_REMOTE_DESKTOP_ENDPOINT, settings.codexHome, settings.runtime);
      await mkdir(join(data.directory, data.credentials.deviceId), { recursive: true });
      agent.on('status', status => send({ type: 'status', status }));
      agent.on('diagnostic', ({ code }) => send({ type: 'diagnostic', code }));
      if (remotePaused) agent.disconnect();
      await agent.start(); send({ type: 'status', status: agent.status() });
    } else if (data.action === 'disconnect') { remotePaused = true; agent?.disconnect(); }
    else if (data.action === 'reconnect') { remotePaused = false; agent?.reconnect(); }
    else if (data.action === 'stop') { await agent?.stop(); agent = null; }
    send({ type: 'reply', id: data.id, ok: true });
  } catch { send({ type: 'reply', id: data.id, ok: false }); }
});
