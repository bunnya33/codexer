import type { FileInfo } from "../../../packages/protocol/src/files";
import type { FileSource } from "./file-transfer";
import { downloadManaged, downloadSeed } from './downloads-mobile';

/** Keep files and checkpoints in the phone's persistent download library. */
export async function downloadFile(
  source: FileSource,
  info: FileInfo,
  signal: AbortSignal,
  progress: (fraction: number) => void,
): Promise<void> {
  await downloadManaged(downloadSeed(source, { name: info.name, size: info.size, version: info.version }), signal, progress, { pauseOnAbort: false });
}
