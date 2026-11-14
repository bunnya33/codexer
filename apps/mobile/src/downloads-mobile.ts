import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { requireNativeModule } from 'expo';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';
import { DownloadManager, downloadRecordSchema, downloadResponseBytes } from '../../../packages/client-shared/src/downloads';
import type { DownloadRecord, DownloadSeed } from '../../../packages/client-shared/src/downloads';
import { fileError } from './file-transfer';
import type { FileSource } from './file-transfer';
import { relay } from './relay';
import { randomId } from './runtime';
import { DownloadCompletionNotice } from '../../../packages/client-shared/src/download-notices';
import type { ClientInstallResult } from './client-update-state';

function directory(id?: string) {
  if (!FileSystem.documentDirectory) throw new Error('当前设备无法保存文件。');
  if (id && !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('下载记录无效。');
  return FileSystem.documentDirectory + 'downloads-v1/' + (id ? id + '/' : '');
}
function safeName(name: string) {
  const clean = (name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'download').replace(/^\.+$/, 'download');
  if (clean.length <= 180) return clean;
  const extension = /\.[a-z0-9]{1,12}$/i.exec(clean)?.[0] ?? '';
  return clean.slice(0, 180 - extension.length) + extension;
}
const names = new Map<string, string>();
const releases = new Map<string, string>();
function dataUri(id: string) { return directory(id) + 'file/' + safeName(names.get(id) ?? 'download'); }
export function localDownloadUri(item: DownloadRecord) { return directory(item.id) + 'file/' + safeName(item.name); }
async function fileSize(uri: string) { const info = await FileSystem.getInfoAsync(uri); return info.exists && !info.isDirectory ? info.size : null; }
async function save(record: DownloadRecord) {
  names.set(record.id, record.name);
  if (record.release) releases.set(record.id, record.release.id);
  await FileSystem.makeDirectoryAsync(directory(record.id) + 'file/', { intermediates: true });
  // Alternating journals retain the previous checkpoint if the process dies
  // while writing a new one. Neither journal contains an Authorization token.
  await FileSystem.writeAsStringAsync(directory(record.id) + `record-${record.revision % 2}.json`, JSON.stringify(downloadRecordSchema.parse(record)));
}
async function load(): Promise<DownloadRecord[]> {
  await FileSystem.makeDirectoryAsync(directory(), { intermediates: true });
  const records: DownloadRecord[] = [];
  for (const id of await FileSystem.readDirectoryAsync(directory())) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) continue;
    const versions: DownloadRecord[] = [];
    for (const slot of [0, 1]) {
      try {
        const parsed = downloadRecordSchema.parse(JSON.parse(await FileSystem.readAsStringAsync(directory(id) + `record-${slot}.json`)));
        if (parsed.id === id) versions.push(parsed);
      } catch { /* The other journal may contain the last complete checkpoint. */ }
    }
    const record = versions.sort((a, b) => b.revision - a.revision)[0];
    if (record) { names.set(record.id, record.name); if (record.release) releases.set(record.id, record.release.id); records.push(record); }
  }
  // Bring APKs retained by older versions into the persistent library once.
  const legacy = FileSystem.cacheDirectory && FileSystem.cacheDirectory + 'codexer-updates/';
  if (legacy && (await FileSystem.getInfoAsync(legacy)).exists) {
    for (const name of await FileSystem.readDirectoryAsync(legacy)) {
      const id = name.replace(/\.apk$/i, '');
      if (!/^[a-f0-9-]{36}$/i.test(id) || name === id || records.some(item => item.id === id || item.release?.id === id)) continue;
      const size = await fileSize(legacy + name); if (!size || size > 512 * 1024 * 1024) continue;
      const parsed = downloadRecordSchema.safeParse({ id, revision: 1, name: `历史安装包-${id.slice(0, 8)}.apk`, size, received: size, createdAt: Date.now(), state: 'completed', error: '' });
      if (!parsed.success) continue;
      const record = parsed.data;
      names.set(id, record.name);
      await FileSystem.makeDirectoryAsync(directory(id) + 'file/', { intermediates: true });
      await FileSystem.copyAsync({ from: legacy + name, to: dataUri(id) });
      await save(record); records.push(record);
      await FileSystem.deleteAsync(legacy + name, { idempotent: true });
    }
  }
  return records;
}

export const mobileDownloads = new DownloadManager({
  load, save, id: randomId, now: Date.now,
  size: id => fileSize(dataUri(id)),
  reset: async id => {
    await FileSystem.makeDirectoryAsync(directory(id) + 'file/', { intermediates: true });
    new File(dataUri(id)).create({ overwrite: true });
  },
  remove: async id => {
    const release = releases.get(id);
    if (release && FileSystem.cacheDirectory) await FileSystem.deleteAsync(FileSystem.cacheDirectory + 'codexer-updates/' + release + '.apk', { idempotent: true });
    await FileSystem.deleteAsync(directory(id), { idempotent: true }); names.delete(id); releases.delete(id);
  },
  block: async (record, start, end, signal, progress) => {
    if (!record.remote) throw new Error('下载来源不可用。');
    const source = relay.downloadSource(record.remote), pending = directory(record.id) + 'pending';
    await FileSystem.deleteAsync(pending, { idempotent: true });
    const task = FileSystem.createDownloadResumable(source.uri, pending, {
      headers: { ...source.headers, Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
      sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
    }, value => progress(value.totalBytesWritten));
    const abort = () => { void task.cancelAsync().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) throw new Error('下载已暂停');
      const response = await task.downloadAsync();
      if (signal.aborted) throw new Error('下载已暂停');
      const length = await fileSize(pending);
      if (!response || length === null) throw new Error('下载失败，请重试。');
      if (![200, 206].includes(response.status) && length < 64 * 1024) {
        let code: string | undefined;
        try { code = JSON.parse(await FileSystem.readAsStringAsync(pending)).error; } catch { /* Use HTTP status below. */ }
        if (code) throw new Error(fileError(new Error(code)));
      }
      const range = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-range')?.[1];
      const count = downloadResponseBytes(response.status, range, length, start, end, record.size);
      if (response.status === 200) {
        // Older Relay versions can return a full response. Replace only from
        // offset zero; an ignored Range must never be appended to a partial.
        await FileSystem.copyAsync({ from: pending, to: dataUri(record.id) });
      } else {
        const bytes = await new File(pending).bytes();
        if (signal.aborted) throw new Error('下载已暂停');
        const output = new File(dataUri(record.id));
        if (!output.exists) output.create();
        const handle = output.open();
        try { handle.offset = start; handle.writeBytes(bytes); } finally { handle.close(); }
      }
      return count;
    } finally {
      signal.removeEventListener('abort', abort);
      await FileSystem.deleteAsync(pending, { idempotent: true }).catch(() => {});
    }
  },
});

export function downloadSeed(source: FileSource, value: Omit<DownloadSeed, 'remote'>): DownloadSeed {
  const view = relay.getSnapshot();
  if (!view.userId || !view.url || !source.uri.startsWith(view.url + '/v1/')) throw new Error('下载登录状态已变化，请重新打开文件。');
  const remote = { relayUrl: view.url, userId: view.userId, path: source.uri.slice(view.url.length) };
  relay.downloadSource(remote);
  return { ...value, remote };
}

export const downloadCompletionNotice = new DownloadCompletionNotice(mobileDownloads, {
  load: async () => {
    const value: unknown = JSON.parse(await FileSystem.readAsStringAsync(directory() + 'seen-completions.json'));
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string' && /^[a-f0-9-]{36}:\d+$/.test(key)) : [];
  },
  save: seen => FileSystem.writeAsStringAsync(directory() + 'seen-completions.json', JSON.stringify(seen)),
});

export async function downloadManaged(seed: DownloadSeed, signal: AbortSignal, progress: (value: number) => void, { pauseOnAbort = true } = {}) {
  if (signal.aborted) throw new Error('file-cancelled');
  const item = await mobileDownloads.enqueue(seed);
  if (signal.aborted && pauseOnAbort) throw new Error('file-cancelled');
  return new Promise<DownloadRecord>((resolve, reject) => {
    const off = mobileDownloads.subscribe(() => {
      const current = mobileDownloads.getSnapshot().items.find(value => value.id === item.id);
      if (current && !signal.aborted) progress(current.size ? current.transferred / current.size : 1);
    });
    const cleanup = () => { off(); signal.removeEventListener('abort', abort); };
    const abort = () => {
      cleanup();
      if (pauseOnAbort) void mobileDownloads.pause(item.id);
      reject(new Error('file-cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    // The manager owns the transfer. A dismissed file reader only detaches its
    // progress observer; the list retains pause/delete controls and errors.
    void mobileDownloads.start(item.id).then(result => {
      if (!signal.aborted) { progress(1); resolve(result); }
    }, reject).catch(reject).finally(cleanup);
    if (signal.aborted) abort();
  });
}

type Installer = { verifyApk(uri: string, size: number, sha256: string): Promise<boolean>; openInstaller(uri: string): Promise<ClientInstallResult> };
async function readyUri(item: DownloadRecord) {
  if (item.state !== 'completed' || await fileSize(dataUri(item.id)) !== item.size) throw new Error('本地文件不可用，请重新下载。');
  return localDownloadUri(item);
}
export async function shareDownload(item: DownloadRecord) {
  if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备无法分享文件。');
  await Sharing.shareAsync(await readyUri(item), { dialogTitle: item.name });
}
export async function openDownload(item: DownloadRecord, options: { signal?: AbortSignal; phase?: (phase: 'verifying' | 'installing') => void } = {}): Promise<ClientInstallResult | void> {
  const check = () => { if (options.signal?.aborted) throw new Error('下载已暂停'); };
  check();
  let uri = await readyUri(item);
  if (Platform.OS === 'android') {
    if (/\.apk$/i.test(item.name)) {
      const installer = requireNativeModule<Installer>('CodexerUpdates');
      if (item.release) {
        options.phase?.('verifying');
        if (!FileSystem.cacheDirectory) throw new Error('无法创建安装缓存。');
        const cache = FileSystem.cacheDirectory + 'codexer-updates/';
        await FileSystem.makeDirectoryAsync(cache, { intermediates: true });
        uri = cache + item.release.id + '.apk';
        await FileSystem.copyAsync({ from: dataUri(item.id), to: uri });
        check();
        const valid = await installer.verifyApk(uri, item.size, item.release.sha256);
        check();
        if (!valid) {
          await FileSystem.deleteAsync(uri, { idempotent: true });
          await mobileDownloads.invalidate(item.id, '安装包校验失败，请重新下载。');
          throw new Error('安装包校验失败，请重新下载。');
        }
      }
      check(); options.phase?.('installing');
      const content = await FileSystem.getContentUriAsync(uri);
      check();
      return installer.openInstaller(content);
    }
    const extension = item.name.split('.').pop()?.toLowerCase() ?? '';
    const mime: Record<string, string> = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', zip: 'application/zip', mp3: 'audio/mpeg', mp4: 'video/mp4' };
    try { await IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data: await FileSystem.getContentUriAsync(uri), type: mime[extension] ?? 'application/octet-stream', flags: 1 }); return; }
    catch { /* Offer the system share sheet when no direct viewer is installed. */ }
  }
  await shareDownload(item);
}
