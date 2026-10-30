import {createInterface} from 'node:readline';
import {mkdir, readFile, writeFile, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createDecipheriv} from 'node:crypto';
import {ConnectorController, defaultSettings, type Vault, type Worker} from '../../desktop/src/controller.js';
import {agentProfile} from '../../desktop/src/profile.js';
import type {Settings} from '../../desktop/src/types.js';
import {DesktopClientUpdates} from '../../desktop/src/client-updates.js';
import {PcAgent} from '../../pc-agent/src/agent.js';
import {resolveCodexBinary} from '../../../packages/codex-adapter/src/binary.js';
const directory = process.env.CODEXER_USER_DATA_DIR || agentProfile(process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support') : process.env.APPDATA || homedir(), process.platform);
const version = process.env.CODEXER_AGENT_BUILD_VERSION || 'development';
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
const pending = new Map<number, {resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout}>();
let sequence = 0, controller: ConnectorController, agent: PcAgent | null = null, shuttingDown = false;
function native<T = any>(method: string, value: unknown = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const nativeId = ++sequence;
    const timer = setTimeout(() => {pending.delete(nativeId); reject(new Error('native-request-timeout'));}, 30000);
    pending.set(nativeId, {resolve, reject, timer}); send({nativeId, method, value});
  });
}
async function atomic(name: string, value: string | Uint8Array) {
  await writeFile(join(directory, name + '.tmp'), value, {mode: 0o600}); await rename(join(directory, name + '.tmp'), join(directory, name));
}
async function decrypt(bytes: Uint8Array): Promise<Buffer> {
  return Buffer.from(await native<string>('unprotect', {value: Buffer.from(bytes).toString('base64')}), 'base64');
}
async function legacyCredentials() {
  const bytes = await readFile(join(directory, 'session.enc')).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
  if (!bytes) return null;
  if (process.platform !== 'win32' || bytes.subarray(0, 3).toString() !== 'v10') return JSON.parse((await decrypt(bytes)).toString());
  const state = JSON.parse(await readFile(join(directory, 'Local State'), 'utf8'));
  const wrapped = Buffer.from(state.os_crypt?.encrypted_key || '', 'base64');
  if (wrapped.subarray(0, 5).toString() !== 'DPAPI') throw new Error('unsupported-credential-key');
  const key = await decrypt(wrapped.subarray(5));
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(3, 15)); cipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(15, -16)), cipher.final()]).toString());
}
const target = process.platform === 'darwin' ? process.arch === 'arm64' ? 'agent-macos-arm64' : 'agent-macos-x64'
  : process.env.PORTABLE_EXECUTABLE_FILE || process.env.CODEXER_AGENT_PORTABLE ? 'agent-windows-x64-portable' : 'agent-windows-x64-setup';
const updates = new DesktopClientUpdates(target, version, join(directory, 'client-updates'), value => send({event: 'updates', value}));
const ready = (async () => {
  await mkdir(directory, {recursive: true, mode: 0o700});
  let secure = false;
  const vault: Vault = {
    async initialize() {secure = !!await native('vault.available');}, available: () => secure,
    async read() {
      const bytes = await readFile(join(directory, 'session.native.enc')).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
      if (bytes) return JSON.parse((await decrypt(bytes)).toString());
      const saved = await legacyCredentials();
      // Keep the old encrypted file as a rollback source until the Qt login has been written successfully.
      if (saved) await vault.write(saved);
      return saved;
    },
    async write(value) {await atomic('session.native.enc', Buffer.from(await native<string>('protect', {value: Buffer.from(JSON.stringify(value)).toString('base64')}), 'base64'));},
    async clear() {await rm(join(directory, 'session.native.enc'), {force: true}); await rm(join(directory, 'session.enc'), {force: true});},
  };
  const inheritedCodexBinary = process.env.CODEX_REMOTE_CODEX_BIN;
  const worker: Worker = {
    async start(credentials, settings) {
      if (agent) throw new Error('already-started');
      process.env.CODEX_HOME = settings.codexHome;
      process.env.CODEX_REMOTE_ALLOW_HTTP = settings.allowHttp ? '1' : '0';
      const override = settings.codexBinary || inheritedCodexBinary;
      if (override) process.env.CODEX_REMOTE_CODEX_BIN = override; else delete process.env.CODEX_REMOTE_CODEX_BIN;
      try {await resolveCodexBinary(); controller.log('codex-binary-found');} catch {controller.log('codex-binary-not-found');}
      const data = join(directory, 'agent', credentials.deviceId); await mkdir(data, {recursive: true});
      agent = new PcAgent(credentials, data, [], process.env.CODEX_REMOTE_DESKTOP_ENDPOINT, settings.codexHome, settings.runtime, undefined, settings.projectParents);
      agent.on('status', status => controller.update(status)); agent.on('diagnostic', ({code}) => controller.log(code));
      await agent.start(); controller.update(agent.status());
    },
    async disconnect() {agent?.disconnect();}, async reconnect() {agent?.reconnect();},
    async refreshRuntime() {await agent?.refreshRuntime(true);}, async stop() {await agent?.stop(); agent = null;},
  };
  let settings = defaultSettings();
  try {settings = {...settings, ...JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))};} catch { /* Fresh profile. */ }
  const persist = async (value: Settings) => {
    await native('loginItem', {enabled: value.openAtLogin}); await atomic('settings.json', JSON.stringify(value, null, 2));
  };
  try {controller = new ConnectorController(vault, worker, settings, persist, version);}
  catch {controller = new ConnectorController(vault, worker, defaultSettings(), persist, version); controller.log('settings-recovery-required');}
  controller.on('state', state => {send({event: 'state', value: state}); updates.configure(controller.updateConnection());});
  await controller.initialize(); await persist(controller.state().settings); controller.log('console-ready');
})();
async function dispatch(method: string, value: any) {
  await ready;
  switch (method) {
    case 'state': return controller.state();
    case 'save': await controller.save(value); return true;
    case 'login': {
      if (typeof value.username !== 'string' || typeof value.password !== 'string') throw new Error('invalid-login');
      await controller.login(value.username, value.password); return true;
    }
    case 'logout': await controller.logout(); return true;
    case 'connect': await controller.connect(); return true;
    case 'disconnect': await controller.disconnect(); return true;
    case 'reconnect': await controller.reconnect(); return true;
    case 'refreshRuntime': await controller.refreshRuntime(); return true;
    case 'releaseSessions': return agent ? agent.releaseIdleSessions() : {released: 0, deferred: 0};
    case 'exportLogs': {
      const path = await native<string>('saveDialog', {name: 'codexer-diagnostics.json'}); if (!path) return null;
      const state = controller.state(); await writeFile(path, JSON.stringify({version, ui: 'Qt Widgets', platform: process.platform, phase: state.phase, status: state.status, logs: state.logs}, null, 2)); return path;
    }
    case 'updates.state': return updates.state();
    case 'updates.check': await updates.check(); return true;
    case 'updates.download': await updates.download(); return true;
    case 'updates.cancel': await updates.cancel(); return true;
    case 'updates.open': {
      const state = controller.state();
      if (state.busy || state.status?.activeTasks) throw new Error('请等待本机任务完成后再安装更新。');
      return native(target === 'agent-windows-x64-portable' ? 'showPackage' : 'openPackage', {path: await updates.verifiedPackage()});
    }
    case 'openControl': return native('openUrl', {url: new URL('/control', controller.state().settings.relayUrl).href});
    case 'shutdown': updates.dispose(); shuttingDown = true; await controller.shutdown(); return true;
    default: throw new Error('unknown-operation');
  }
}
createInterface({input: process.stdin, crlfDelay: Infinity}).on('line', line => {
  if (line.length > 1024 * 1024) return;
  let message: any; try {message = JSON.parse(line);} catch {return;}
  if (message.nativeId) {
    const waiter = pending.get(message.nativeId); if (!waiter) return;
    pending.delete(message.nativeId); clearTimeout(waiter.timer);
    message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.value); return;
  }
  if (!Number.isSafeInteger(message.id) || typeof message.method !== 'string') return;
  void dispatch(message.method, message.value ?? {}).then(value => {send({id: message.id, value: value ?? null}); if (shuttingDown) setTimeout(() => process.exit(0), 100).unref();})
    .catch(error => send({id: message.id, error: error instanceof Error ? error.message : 'operation-failed'}));
}).on('close', () => {void controller?.shutdown().finally(() => process.exit(0));});
ready.catch(() => send({event: 'fatal', value: '本机服务初始化失败，请检查系统凭据与配置目录。'}));
process.on('uncaughtException', () => send({event: 'fatal', value: '本机服务异常，请导出诊断并重新启动。'}));
process.on('unhandledRejection', () => send({event: 'fatal', value: '本机服务操作失败，请查看诊断。'}));
