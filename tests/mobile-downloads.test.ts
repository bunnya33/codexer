import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(), directories: new Set<string>(), body: new Uint8Array(),
  requests: [] as { uri: string; headers: Record<string, string> }[],
  platform: 'android', token: 'current-token', user: 'user-a', status: 206,
  gate: undefined as undefined | (() => Promise<void>),
  verify: vi.fn(), install: vi.fn(), share: vi.fn(), view: vi.fn(),
}));
const text = (value: string) => new TextEncoder().encode(value);
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/', cacheDirectory: 'file:///cache/', FileSystemSessionType: { FOREGROUND: 0 },
  makeDirectoryAsync: async (uri: string) => { m.directories.add(uri); },
  getInfoAsync: async (uri: string) => m.files.has(uri) ? { exists: true, isDirectory: false, size: m.files.get(uri)!.length } : { exists: m.directories.has(uri), isDirectory: m.directories.has(uri) },
  readDirectoryAsync: async (uri: string) => [...new Set([...m.files.keys(), ...m.directories].filter(key => key.startsWith(uri)).map(key => key.slice(uri.length).split('/')[0]!).filter(Boolean))],
  readAsStringAsync: async (uri: string) => { if (!m.files.has(uri)) throw Error('missing'); return new TextDecoder().decode(m.files.get(uri)); },
  writeAsStringAsync: async (uri: string, value: string) => { m.files.set(uri, new TextEncoder().encode(value)); },
  deleteAsync: async (uri: string) => { for (const key of m.files.keys()) if (key === uri || key.startsWith(uri.endsWith('/') ? uri : uri + '/')) m.files.delete(key); },
  copyAsync: async ({ from, to }: { from: string; to: string }) => { if (!m.files.has(from)) throw Error('missing'); m.files.set(to, m.files.get(from)!.slice()); },
  getContentUriAsync: async (uri: string) => 'content://app.FileSystemFileProvider/' + encodeURIComponent(uri),
  createDownloadResumable: (uri: string, file: string, options: { headers: Record<string, string> }, progress: (value: { totalBytesWritten: number }) => void) => {
    m.requests.push({ uri, headers: options.headers }); let cancelled = false;
    return { cancelAsync: async () => { cancelled = true; }, downloadAsync: async () => {
      await m.gate?.();
      if (cancelled) return null;
      const range = /bytes=(\d+)-(\d+)/.exec(options.headers.Range!)!;
      const start = Number(range[1]), end = Number(range[2]);
      const body = m.status === 200 ? m.body : m.body.slice(start, end + 1);
      m.files.set(file, body.slice()); progress({ totalBytesWritten: body.length });
      return { status: m.status, headers: { 'Content-Range': `bytes ${start}-${end}/${m.body.length}` } };
    } };
  },
}));
vi.mock('expo-file-system', () => ({ File: class {
  constructor(readonly uri: string) {}
  get exists() { return m.files.has(this.uri); }
  create() { m.files.set(this.uri, new Uint8Array()); }
  async bytes() { return m.files.get(this.uri)!.slice(); }
  open() {
    const uri = this.uri;
    return { offset: 0, close() {}, writeBytes(value: Uint8Array) {
      const old = m.files.get(uri) ?? new Uint8Array(), next = new Uint8Array(Math.max(old.length, this.offset + value.length));
      next.set(old); next.set(value, this.offset); m.files.set(uri, next);
    } };
  }
} }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync: (...args: unknown[]) => m.share(...args) }));
vi.mock('expo-intent-launcher', () => ({ startActivityAsync: (...args: unknown[]) => m.view(...args) }));
vi.mock('react-native', () => ({ Platform: { get OS() { return m.platform; } } }));
vi.mock('expo', () => ({ requireNativeModule: () => ({ verifyApk: (...args: unknown[]) => m.verify(...args), openInstaller: (...args: unknown[]) => m.install(...args) }) }));
vi.mock('../apps/mobile/src/runtime', () => ({ randomId: () => '00000000-0000-4000-8000-000000000002' }));
vi.mock('../apps/mobile/src/relay', () => ({ relay: {
  getSnapshot: () => ({ url: 'https://relay.test', userId: m.user, phase: 'connected' }),
  downloadSource: (remote: { relayUrl: string; userId: string; path: string }) => {
    if (remote.userId !== m.user || remote.relayUrl !== 'https://relay.test') throw Error('original-account-required');
    return { uri: remote.relayUrl + remote.path, headers: { Authorization: 'Bearer ' + m.token } };
  },
} }));

const source = { uri: 'https://relay.test/v1/client-releases/control-android/00000000-0000-4000-8000-000000000001/download', headers: { Authorization: 'Bearer old-token' } };
const release = { id: '00000000-0000-4000-8000-000000000001', sha256: 'a'.repeat(64) };
const modulePath: string = '../apps/mobile/src/downloads-mobile';
const fileModulePath: string = '../apps/mobile/src/file-download';
async function download(name = 'FrogCoder.apk', updater = true) {
  const api = await import(modulePath);
  const item = await api.downloadManaged(api.downloadSeed(source, { name, size: m.body.length, ...(updater ? { release } : {}) }), new AbortController().signal, () => {});
  return { api, item };
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); m.files.clear(); m.directories.clear(); m.requests.length = 0;
  m.platform = 'android'; m.user = 'user-a'; m.token = 'current-token'; m.status = 206;
  m.gate = undefined;
  m.body = text('complete-file'); m.verify.mockResolvedValue(true); m.install.mockResolvedValue('opened'); m.share.mockResolvedValue(undefined); m.view.mockResolvedValue(undefined);
});

it('keeps downloaded APKs in documents, reopens them after restart and never persists bearer tokens', async () => {
  const { api, item } = await download();
  expect(api.localDownloadUri(item)).toContain('file:///documents/downloads-v1/');
  expect(m.requests[0]!.headers.Authorization).toBe('Bearer current-token');
  const journals = [...m.files].filter(([uri]) => uri.endsWith('.json')).map(([, bytes]) => new TextDecoder().decode(bytes)).join('');
  expect(journals).not.toMatch(/Bearer|old-token|current-token/);
  await api.openDownload(item); expect(m.verify).toHaveBeenCalledOnce(); expect(m.install).toHaveBeenCalledOnce();
  vi.resetModules(); const again = await import(modulePath); await again.mobileDownloads.initialize();
  expect(again.mobileDownloads.getSnapshot().items[0].state).toBe('completed');
  await again.openDownload(again.mobileDownloads.getSnapshot().items[0]);
  expect(m.requests).toHaveLength(1); expect(m.verify).toHaveBeenCalledTimes(2); expect(m.install).toHaveBeenCalledTimes(2);
});

it.each(['ios', 'android'])('continues a %s file download after its reader is dismissed and acknowledges completion persistently', async platform => {
  m.platform = platform;
  let finish!: () => void, started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  m.gate = () => { started(); return new Promise<void>(resolve => { finish = resolve; }); };
  const api = await import(modulePath); await api.downloadCompletionNotice.initialize();
  const observer = new AbortController(), progress = vi.fn();
  const waiting = api.downloadManaged(api.downloadSeed(source, { name: 'FrogCoder.ipa', size: m.body.length }), observer.signal, progress, { pauseOnAbort: false });
  const detached = expect(waiting).rejects.toThrow('file-cancelled');
  await reached; observer.abort(); await detached;
  expect(api.mobileDownloads.getSnapshot().items[0].state).toBe('downloading');
  const observed = progress.mock.calls.length;
  const transfer = api.mobileDownloads.start(api.mobileDownloads.getSnapshot().items[0].id);
  finish(); await transfer;
  expect(progress).toHaveBeenCalledTimes(observed);
  expect(api.mobileDownloads.getSnapshot().items[0].state).toBe('completed');
  expect(m.requests).toHaveLength(1); expect(api.downloadCompletionNotice.getSnapshot()).toBe(true);
  await api.downloadCompletionNotice.markRead(); expect(api.downloadCompletionNotice.getSnapshot()).toBe(false);
  vi.resetModules(); const again = await import(modulePath); await again.downloadCompletionNotice.initialize();
  expect(again.downloadCompletionNotice.getSnapshot()).toBe(false);
});

it('still allows an explicit cancellation to pause a managed update download', async () => {
  let started!: () => void; const reached = new Promise<void>(resolve => { started = resolve; });
  // Use the manager block port to ensure cancellation settles the active request.
  const api = await import(modulePath), observer = new AbortController();
  m.gate = async () => { started(); await new Promise<void>(resolve => observer.signal.addEventListener('abort', () => resolve(), { once: true })); };
  const waiting = api.downloadManaged(api.downloadSeed(source, { name: 'update.apk', size: m.body.length }), observer.signal, () => {});
  const paused = expect(waiting).rejects.toThrow('file-cancelled');
  await reached; observer.abort(); await paused;
  await api.mobileDownloads.pauseAll();
  expect(api.mobileDownloads.getSnapshot().items[0].state).toBe('paused');
});

it('starts a file-reader download even when its reader closes while the record is being created', async () => {
  const api = await import(modulePath), { downloadFile } = await import(fileModulePath);
  const observer = new AbortController();
  const waiting = downloadFile(source, { name: 'FrogCoder.ipa', size: m.body.length, version: 'a'.repeat(64) }, observer.signal, () => {});
  observer.abort();
  await expect(waiting).rejects.toThrow('file-cancelled');
  const item = api.mobileDownloads.getSnapshot().items[0];
  await api.mobileDownloads.start(item.id);
  expect(m.requests).toHaveLength(1); expect(api.mobileDownloads.getSnapshot().items[0].state).toBe('completed');
});

it('verifies native size/digest before each installer launch and retains files after permission approval', async () => {
  const { api, item } = await download(); const phases: string[] = [];
  m.install.mockResolvedValueOnce('permission-required');
  expect(await api.openDownload(item, { phase: (phase: string) => phases.push(phase) })).toBe('permission-required');
  expect(phases).toEqual(['verifying', 'installing']);
  expect(await api.openDownload(item)).toBe('opened'); expect(m.requests).toHaveLength(1);
});

it('quarantines an invalid APK and never opens it', async () => {
  const { api, item } = await download(); m.verify.mockResolvedValue(false);
  await expect(api.openDownload(item)).rejects.toThrow('校验失败'); expect(m.install).not.toHaveBeenCalled();
  expect(api.mobileDownloads.getSnapshot().items[0]).toMatchObject({ state: 'failed', received: 0 });
});

it('does not launch the installer when cancelled during native verification', async () => {
  const { api, item } = await download(), controller = new AbortController();
  m.verify.mockImplementation(async () => { controller.abort(); return true; });
  await expect(api.openDownload(item, { signal: controller.signal })).rejects.toThrow('暂停'); expect(m.install).not.toHaveBeenCalled();
  expect(api.mobileDownloads.getSnapshot().items[0].state).toBe('completed');
});

it('recovers the previous journal if the newest one is truncated', async () => {
  const { api, item } = await download();
  const journals = [...m.files].filter(([uri]) => uri.endsWith('.json')).sort((a, b) => JSON.parse(new TextDecoder().decode(b[1])).revision - JSON.parse(new TextDecoder().decode(a[1])).revision);
  m.files.set(journals[0]![0], text('{truncated'));
  vi.resetModules(); const again = await import(modulePath); await again.mobileDownloads.initialize();
  const restored = again.mobileDownloads.getSnapshot().items[0]; expect(restored.received).toBe(item.size);
  await again.mobileDownloads.start(item.id); expect(m.requests).toHaveLength(1);
});

it('imports APKs cached by the old app into the persistent library without another download', async () => {
  const cache = 'file:///cache/codexer-updates/'; m.directories.add(cache); m.files.set(cache + release.id + '.apk', m.body);
  const api = await import(modulePath); await api.mobileDownloads.initialize();
  const item = api.mobileDownloads.getSnapshot().items[0]; expect(item.name).toContain('历史安装包');
  await api.openDownload(item); expect(m.requests).toEqual([]); expect(m.install).toHaveBeenCalledOnce();
  vi.resetModules(); const again = await import(modulePath); await again.mobileDownloads.initialize(); expect(again.mobileDownloads.getSnapshot().items).toHaveLength(1);
});

it('permanently deletes both a managed APK and its installation cache without importing it again', async () => {
  const { api, item } = await download(); await api.openDownload(item);
  await api.mobileDownloads.remove(item.id);
  expect(m.files.has(api.localDownloadUri(item))).toBe(false);
  expect(m.files.has('file:///cache/codexer-updates/' + release.id + '.apk')).toBe(false);
  vi.resetModules(); const again = await import(modulePath); await again.mobileDownloads.initialize();
  expect(again.mobileDownloads.getSnapshot().items).toEqual([]);
});

it('uses the system viewer or share sheet for files and keeps them available offline', async () => {
  const { api, item } = await download('report.pdf', false); await api.openDownload(item);
  expect(m.view).toHaveBeenCalledWith('android.intent.action.VIEW', expect.objectContaining({ type: 'application/pdf', flags: 1 }));
  m.user = 'different-account'; m.platform = 'ios'; await api.openDownload(item); expect(m.share).toHaveBeenCalledOnce();
  expect(m.files.has(api.localDownloadUri(item))).toBe(true);
});

it('blocks resuming under a different account and fetches fresh credentials on retry', async () => {
  const api = await import(modulePath), seed = api.downloadSeed(source, { name: 'file.apk', size: m.body.length });
  const item = await api.mobileDownloads.enqueue(seed); m.user = 'different-account';
  await expect(api.mobileDownloads.start(item.id)).rejects.toThrow('original-account-required'); expect(m.requests).toEqual([]);
  m.user = 'user-a'; m.token = 'renewed-token'; await api.mobileDownloads.start(item.id); expect(m.requests[0]!.headers.Authorization).toBe('Bearer renewed-token');
});

it('supports older servers returning a full response only at offset zero', async () => {
  m.status = 200; const { api, item } = await download('document.txt', false);
  expect(api.mobileDownloads.getSnapshot().items[0].state).toBe('completed');
  expect(m.files.get(api.localDownloadUri(item))).toEqual(m.body);
});
