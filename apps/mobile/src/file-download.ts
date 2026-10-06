import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type { FileInfo } from "../../../packages/protocol/src/files";
import type { FileSource } from "./file-transfer";
import { randomId } from "./runtime";

/** 原生端流式写入临时文件，再由系统保存/分享；取消和分享结束后清理。 */
export async function downloadFile(
  source: FileSource,
  info: FileInfo,
  signal: AbortSignal,
  progress: (fraction: number) => void,
): Promise<void> {
  if (!FileSystem.cacheDirectory || !(await Sharing.isAvailableAsync()))
    throw new Error("当前设备无法保存文件");
  const directory = `${FileSystem.cacheDirectory}codexer-${randomId()}/`;
  const name = info.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120) || "download";
  const uri = directory + name;
  await FileSystem.makeDirectoryAsync(directory);
  const task = FileSystem.createDownloadResumable(
    source.uri,
    uri,
    { headers: source.headers },
    (value) => {
      if (info.size) progress(Math.min(1, value.totalBytesWritten / info.size));
    },
  );
  const abort = () => {
    void task.cancelAsync().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("file-cancelled");
    const result = await task.downloadAsync();
    if (signal.aborted) throw new Error("file-cancelled");
    if (!result || result.status !== 200) {
      let code = "文件下载失败，请重试";
      try {
        code = JSON.parse(await FileSystem.readAsStringAsync(uri)).error ?? code;
      } catch {
        /* 保留通用错误。 */
      }
      throw new Error(code);
    }
    const saved = await FileSystem.getInfoAsync(uri);
    if (!saved.exists || saved.isDirectory || saved.size !== info.size)
      throw new Error("invalid-file-response");
    await Sharing.shareAsync(uri, { dialogTitle: `保存 ${info.name}` });
  } finally {
    signal.removeEventListener("abort", abort);
    await FileSystem.deleteAsync(directory, { idempotent: true }).catch(() => undefined);
  }
}
