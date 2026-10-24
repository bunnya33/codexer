import * as FileSystem from "expo-file-system/legacy";
import { File } from "expo-file-system";
import * as IntentLauncher from "expo-intent-launcher";
import { sha256 } from "@noble/hashes/sha2.js";
import type { ClientRelease } from "../../../packages/shared/src/client-release";
import type { FileSource } from "./file-transfer";

export async function downloadClientUpdate(
  source: FileSource,
  release: ClientRelease,
  signal: AbortSignal,
  progress: (value: number) => void,
) {
  if (!FileSystem.cacheDirectory) throw new Error("无法创建更新缓存");
  const directory = FileSystem.cacheDirectory + "codexer-updates/";
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const uri = directory + release.id + ".apk";
  const task = FileSystem.createDownloadResumable(
    source.uri,
    uri,
    { headers: source.headers },
    (value) => progress(Math.min(1, value.totalBytesWritten / release.size)),
  );
  const cancel = () => {
    void task.cancelAsync().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new Error("下载已取消");
    const result = await task.downloadAsync();
    if (signal.aborted) throw new Error("下载已取消");
    const info = await FileSystem.getInfoAsync(uri);
    if (result?.status !== 200 || !info.exists || info.isDirectory || info.size !== release.size)
      throw new Error("安装包下载不完整，请重试");
    const file = new File(uri),
      handle = file.open(),
      hash = sha256.create();
    let size = 0;
    try {
      while (size < release.size) {
        if (signal.aborted) throw new Error("下载已取消");
        const chunk = handle.readBytes(Math.min(256 * 1024, release.size - size));
        if (!chunk.length) throw new Error("安装包读取失败");
        hash.update(chunk);
        size += chunk.length;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      handle.close();
    }
    const digest = Array.from(hash.digest())
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    if (digest !== release.sha256) throw new Error("安装包校验失败，请重新下载");
    const content = await FileSystem.getContentUriAsync(uri);
    if (signal.aborted) throw new Error("下载已取消");
    // Keep the verified APK while the system installer reads it. Installation and
    // unknown-source approval remain Android system operations.
    await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
      data: content,
      flags: 1,
      type: "application/vnd.android.package-archive",
    });
  } catch (error) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
