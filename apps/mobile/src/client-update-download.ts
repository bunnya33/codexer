import type { ClientRelease } from '../../../packages/shared/src/client-release';
import type { FileSource } from './file-transfer';
import type { ClientUpdatePhase } from './client-update-state';
import { downloadManaged, downloadSeed, openDownload } from './downloads-mobile';

export async function downloadClientUpdate(
  source: FileSource, release: ClientRelease, signal: AbortSignal,
  progress: (value: number) => void, phase: (value: ClientUpdatePhase) => void = () => {},
) {
  phase('downloading');
  const item = await downloadManaged(downloadSeed(source, {
    name: /\.apk$/i.test(release.name) ? release.name : release.name + '.apk',
    size: release.size, version: release.sha256,
    release: { id: release.id, sha256: release.sha256 },
  }), signal, progress);
  if (signal.aborted) throw new Error('下载已暂停');
  return (await openDownload(item, { signal, phase })) ?? 'opened';
}
