import {createInterface} from 'node:readline';
import {readFile, writeFile, mkdir, rename, rm, stat} from 'node:fs/promises';
import {join, basename, extname} from 'node:path';
import {homedir} from 'node:os';
import {createHash, createDecipheriv, randomUUID} from 'node:crypto';
import {ConnectorController, defaultSettings, type Worker, type Vault} from '../../desktop/src/controller';
import type {Settings} from '../../desktop/src/types';
import type {AgentCredentials} from '../../pc-agent/src/auth';
import {PcAgent} from '../../pc-agent/src/agent';
import {resolveCodexBinary} from '../../../packages/codex-adapter/src/binary';
import {readLegacyControl} from './legacy-control';

const mode = process.env.CODEXER_NATIVE_MODE === 'agent' ? 'agent' : 'control';
const directory = process.env.CODEXER_NATIVE_DATA_DIR || join(process.env.APPDATA || homedir(), mode === 'agent' ? 'Codexer' : 'CodexerControl');
const version = '0.2.3';
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
let sequence = 0;
function native<T = any>(method: string, value: unknown = {}): Promise<T> {
  return new Promise((resolve, reject) => {const nativeId = ++sequence; pending.set(nativeId, {resolve, reject}); send({nativeId, method, value});});
}
const writes = new Map<string,Promise<void>>();
async function atomic(path: string, value: string | Uint8Array) {
  const write=(writes.get(path)||Promise.resolve()).catch(()=>{}).then(async()=>{await writeFile(path+'.tmp',value);await rename(path+'.tmp',path);});
  writes.set(path,write);try{await write;}finally{if(writes.get(path)===write)writes.delete(path);}
}
async function json(path: string) {try {return JSON.parse(await readFile(path, 'utf8'));} catch {return null;}}
async function protect(value: string) {return Buffer.from(await native<string>('protect', {value:Buffer.from(value).toString('base64')}), 'base64');}
async function unprotect(value: Uint8Array) {return Buffer.from(await native<string>('unprotect', {value:Buffer.from(value).toString('base64')}), 'base64');}
async function readVault(name: string) {
  try {return JSON.parse((await unprotect(await readFile(join(directory, name)))).toString('utf8'));} catch {return null;}
}
async function writeVault(name: string, value: unknown) {await atomic(join(directory, name), await protect(JSON.stringify(value)));}
async function legacyAgentCredentials() {
  const encrypted = await readFile(join(directory, 'session.enc')).catch(() => null);
  if (!encrypted) return null;
  try {return JSON.parse((await unprotect(encrypted)).toString('utf8'));} catch { /* Chromium v10 uses a DPAPI protected AES key. */ }
  if (encrypted.subarray(0, 3).toString() !== 'v10') return null;
  const localState = await json(join(directory, 'Local State'));
  const wrapped = Buffer.from(localState?.os_crypt?.encrypted_key || '', 'base64');
  if (wrapped.subarray(0, 5).toString() !== 'DPAPI') return null;
  try {
    const key = await unprotect(wrapped.subarray(5));
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(3, 15));
    decipher.setAuthTag(encrypted.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(15, -16)), decipher.final()]).toString('utf8'));
  } catch {return null;}
}
let agent: PcAgent | null = null;
let controller: ConnectorController | null = null;
let shutdown = false;
let preferences: {closeExits: boolean; serverUrl: string} = {closeExits:false, serverUrl:''};
const selected = new Set<string>();
const transfers = new Map<string, AbortController>();
const mime = (name: string) => ({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.pdf':'application/pdf','.txt':'text/plain','.json':'application/json'} as Record<string,string>)[extname(name).toLowerCase()] || 'application/octet-stream';

const ready = (async () => {
  await mkdir(directory, {recursive:true});
  preferences = {...preferences, ...await json(join(directory, 'preferences.json')), ...await json(join(directory, 'native-preferences.json'))};
  const oldControl = await json(join(directory, 'settings.json'));
  const oldServer = await json(join(directory, 'server.json'));
  if (mode === 'control' && !preferences.serverUrl && typeof oldServer?.url === 'string') preferences.serverUrl = oldServer.url;
  send({event:'preferences', value:preferences});
  if (mode !== 'agent') return;
  const vault: Vault = {
    available: () => true,
    async read() {const saved = await readVault('session.native.enc') || await legacyAgentCredentials(); if (saved) await writeVault('session.native.enc', saved); return saved as AgentCredentials | null;},
    write: value => writeVault('session.native.enc', value),
    async clear() {await rm(join(directory, 'session.native.enc'), {force:true}); await rm(join(directory, 'session.enc'), {force:true});},
  };
  const worker: Worker = {
    async start(credentials, settings) {
      if (agent) throw new Error('already-started');
      process.env.CODEX_HOME = settings.codexHome;
      process.env.CODEX_REMOTE_ALLOW_HTTP = settings.allowHttp ? '1' : '0';
      delete process.env.CODEX_REMOTE_CODEX_BIN;
      if (settings.codexBinary) process.env.CODEX_REMOTE_CODEX_BIN = settings.codexBinary;
      try {process.env.CODEX_REMOTE_CODEX_BIN = await resolveCodexBinary(settings.codexBinary || undefined); controller?.log('codex-binary-found');}
      catch {controller?.log('codex-binary-not-found');}
      const agentDirectory = join(directory, 'agent', credentials.deviceId);
      await mkdir(agentDirectory, {recursive:true});
      agent = new PcAgent(credentials, agentDirectory, [], process.env.CODEX_REMOTE_DESKTOP_ENDPOINT, settings.codexHome, settings.runtime, undefined, settings.projectParents);
      agent.on('status', status => controller?.update(status));
      agent.on('diagnostic', ({code}) => controller?.log(code));
      await agent.start(); controller?.update(agent.status());
    },
    async disconnect() {agent?.disconnect();},
    async reconnect() {agent?.reconnect();},
    async stop() {await agent?.stop(); agent = null;},
  };
  let settings = {...defaultSettings(), ...oldControl};
  const persist = async (next: Settings) => {
    await native('loginItem', {enabled:next.openAtLogin});
    await atomic(join(directory, 'settings.json'), JSON.stringify(next, null, 2));
    send({event:'preferences', value:{...preferences, closeExits:!next.minimizeToTray}});
  };
  try {controller = new ConnectorController(vault, worker, settings, persist, version);}
  catch {settings = defaultSettings(); controller = new ConnectorController(vault, worker, settings, persist, version); controller.log('settings-recovery-required');}
  controller.on('state', state => {send({event:'agentState', value:state}); send({event:'activeTasks', value:state.status?.activeTasks || 0});});
  await controller.initialize();
  await persist(controller.state().settings);
  controller.log('console-ready');
})();

async function dispatch(method: string, value: any) {
  await ready;
  switch (method) {
    case 'diagnostics.enabled': return !!process.env.CODEXER_NATIVE_DATA_DIR;
    case 'diagnostics.snapshot':
      if(!process.env.CODEXER_NATIVE_DATA_DIR)throw new Error('diagnostics-disabled');
      await atomic(join(directory,'native-renderer-state.json'),JSON.stringify(value));return true;
    case 'ready': await atomic(join(directory, 'native-startup.json'), JSON.stringify({version, mode, renderer:'react-native-windows', at:new Date().toISOString(), ...(value || {})})); return true;
    case 'preferences.read': return preferences;
    case 'preferences.save': {
      if (typeof value.closeExits !== 'boolean') throw new Error('invalid-preferences');
      preferences = {...preferences, closeExits:value.closeExits};
      if (mode === 'agent' && controller) await controller.save({...controller.state().settings, minimizeToTray:!value.closeExits});
      await atomic(join(directory, 'native-preferences.json'), JSON.stringify(preferences));
      send({event:'preferences', value:preferences}); return preferences;
    }
    case 'credentials.read': {
      const saved=await readVault('control-session.native.enc');if(saved)return saved;
      if(await json(join(directory,'native-control-migrated.json')))return null;
      const previous=await readLegacyControl(directory,preferences.serverUrl);
      if(previous){await writeVault('control-session.native.enc',previous);await atomic(join(directory,'native-control-migrated.json'),'true');}
      return previous;
    }
    case 'credentials.save': {
      if (mode !== 'control' || typeof value.value !== 'string' || value.value.length > 32000) throw new Error('invalid-credentials');
      const parsed = JSON.parse(value.value);
      await writeVault('control-session.native.enc', parsed);
      if (typeof parsed.url === 'string') {preferences.serverUrl = parsed.url; await atomic(join(directory, 'native-preferences.json'), JSON.stringify(preferences));}
      return true;
    }
    case 'credentials.clear': await atomic(join(directory,'native-control-migrated.json'),'true');await rm(join(directory, 'control-session.native.enc'), {force:true}); return true;
    case 'storage.read': return json(join(directory, 'native-' + createHash('sha256').update(String(value.key)).digest('hex') + '.json'));
    case 'storage.write': {
      const content = JSON.stringify(value.value); if (content.length > 64000) throw new Error('storage-value-too-large');
      await atomic(join(directory, 'native-' + createHash('sha256').update(String(value.key)).digest('hex') + '.json'), content); return true;
    }
    case 'pick': {
      const paths: string[] = await native('pick', {kind:value.kind || 'files', multiple:value.multiple !== false});
      return Promise.all(paths.map(async path => {selected.add(path); const info = await stat(path); return {path, uri:'file:///' + path.replaceAll('\\','/'), name:basename(path), size:info.size, mimeType:mime(path)};}));
    }
    case 'readChunk': {
      if (!selected.has(value.path) || !Number.isSafeInteger(value.position) || value.position < 0 || !Number.isSafeInteger(value.length) || value.length < 0 || value.length > 1024 * 1024) throw new Error('invalid-file-read');
      const {open} = await import('node:fs/promises'); const file = await open(value.path, 'r');
      try {const bytes = Buffer.alloc(value.length); const result = await file.read(bytes, 0, value.length, value.position); return bytes.subarray(0,result.bytesRead).toString('base64');} finally {await file.close();}
    }
    case 'image.convert': if (!selected.has(value.path)) throw new Error('invalid-image'); return native('image.convert', value);
    case 'window.theme': {
      const { controlTheme } = await import('../../../packages/client-shared/src/themes.js');
      const theme = controlTheme(value.id);
      return native(method, { dark: theme.dark, background: parseInt(theme.colors.bg.slice(1), 16), text: parseInt(theme.colors.text.slice(1), 16) });
    }
    case 'clipboard.write': return native('clipboard.write', value);
    case 'randomId': return randomUUID();
    case 'preview.open': if (typeof value.html !== 'string' || value.html.length > 3 * 1024 * 1024) throw new Error('invalid-preview'); return native(method,value);
    case 'preview.send': case 'preview.close': return native(method,value);
    case 'confirm': return native('confirm', value);
    case 'openUrl': {
      const url = new URL(value.url); if (!['https:','http:','mailto:'].includes(url.protocol)) throw new Error('invalid-url');
      return native('openUrl', {url:url.href});
    }
    case 'download.cancel': transfers.get(value.id)?.abort(); return true;
    case 'download': {
      const url = new URL(value.uri); if (!['http:','https:'].includes(url.protocol) || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 512 * 1024 * 1024) throw new Error('invalid-download');
      const abort = new AbortController(); transfers.set(value.id, abort);
      const path = await native<string>('saveDialog', {name:basename(value.name || 'download')});
      if (!path || abort.signal.aborted) {transfers.delete(value.id); if(abort.signal.aborted)throw new Error('file-cancelled');return false;}
      const temporary = path + '.codexer-part-' + randomUUID();
      try {
        const response = await fetch(url, {headers:value.headers || {}, signal:abort.signal});
        if (!response.ok || !response.body) throw new Error('download-failed');
        const {open} = await import('node:fs/promises'); const file = await open(temporary, 'wx'); let size = 0;
        try {for await (const chunk of response.body) {size += chunk.length; if (size > value.size) throw new Error('invalid-file-response'); await file.write(chunk); send({event:'downloadProgress', value:{id:value.id, progress:value.size ? size/value.size : 1}});}} finally {await file.close();}
        if (size !== value.size || abort.signal.aborted) throw new Error('invalid-file-response');
        await rename(temporary, path); return true;
      } finally {transfers.delete(value.id); await rm(temporary, {force:true}).catch(() => {});}
    }
    case 'agent.state': return controller?.state();
    case 'agent.login': if (typeof value.username !== 'string' || typeof value.password !== 'string') throw new Error('invalid-login'); await controller!.login(value.username,value.password); return true;
    case 'agent.logout': await controller!.logout(); return true;
    case 'agent.connect': await controller!.connect(); return true;
    case 'agent.disconnect': await controller!.disconnect(); return true;
    case 'agent.reconnect': await controller!.reconnect(); return true;
    case 'agent.save': await controller!.save(value); return true;
    case 'agent.exportLogs': {
      const path = await native<string>('saveDialog', {name:'codexer-diagnostics.json'}); if (!path) return null;
      const state = controller!.state(); await writeFile(path, JSON.stringify({version, platform:process.platform, phase:state.phase, status:state.status, logs:state.logs},null,2)); return path;
    }
    case 'shutdown': shutdown = true; for (const abort of transfers.values()) abort.abort(); await controller?.shutdown(); return true;
    default: throw new Error('unknown-native-operation');
  }
}

createInterface({input:process.stdin, crlfDelay:Infinity}).on('line', line => {
  if (line.length > 16 * 1024 * 1024) return;
  let message: any; try {message = JSON.parse(line);} catch {return;}
  if (message.nativeId) {const waiter = pending.get(message.nativeId); if (waiter) {pending.delete(message.nativeId); message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.value);} return;}
  if (!Number.isSafeInteger(message.id) || typeof message.method !== 'string') return;
  void dispatch(message.method,message.value || {}).then(value => {send({id:message.id,value:value ?? null}); if (shutdown) setTimeout(() => process.exit(0),100).unref();})
    .catch(error => send({id:message.id,error:error instanceof Error ? error.message : 'native-operation-failed'}));
}).on('close', () => {void Promise.resolve(controller?.shutdown()).finally(() => process.exit(0));});
process.on('uncaughtException', () => {send({event:'backendError',value:'native-service-failed'});});
process.on('unhandledRejection', () => {send({event:'backendError',value:'native-service-failed'});});
