import * as FileSystem from "expo-file-system/legacy";
import { requireNativeModule } from "expo";
import type { ClientRelease } from "../../../packages/shared/src/client-release";
import type { FileSource } from "./file-transfer";
import type { ClientInstallResult, ClientUpdatePhase } from "./client-update-state";

type AndroidInstaller = {
  verifyApk(uri: string, size: number, sha256: string): Promise<boolean>;
  openInstaller(uri: string): Promise<ClientInstallResult>;
};

export async function downloadClientUpdate(
  source: FileSource,
  release: ClientRelease,
  signal: AbortSignal,
  progress: (value: number) => void,
  phase: (value: ClientUpdatePhase) => void = () => {},
) {
  const installer = requireNativeModule<AndroidInstaller>("CodexerUpdates");
  const checkCancelled = () => {
    if (signal.aborted) throw new Error("下载已取消");
  };
  checkCancelled();
  if (!FileSystem.cacheDirectory) throw new Error("无法创建更新缓存");
  const directory = FileSystem.cacheDirectory + "codexer-updates/";
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const uri = directory + release.id + ".apk";
  let verified = false;
  try {
    // Reuse a verified download after granting installation permission or
    // returning from the installer. Always recheck its size and SHA-256.
    const cached = await FileSystem.getInfoAsync(uri);
    checkCancelled();
    if (cached.exists && !cached.isDirectory && cached.size === release.size) {
      phase("verifying");
      verified = await installer.verifyApk(uri, release.size, release.sha256);
      checkCancelled();
    }
    if (!verified) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
      checkCancelled();
      phase("downloading");
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
        checkCancelled();
        const result = await task.downloadAsync();
        checkCancelled();
        const info = await FileSystem.getInfoAsync(uri);
        if (
          result?.status !== 200 ||
          !info.exists ||
          info.isDirectory ||
          info.size !== release.size
        )
          throw new Error("安装包下载不完整，请重试");
      } finally {
        signal.removeEventListener("abort", cancel);
      }
      phase("verifying");
      checkCancelled();
      verified = await installer.verifyApk(uri, release.size, release.sha256);
      checkCancelled();
      if (!verified) throw new Error("安装包校验失败，请重新下载");
    }
    phase("installing");
    const content = await FileSystem.getContentUriAsync(uri);
    checkCancelled();
    return await installer.openInstaller(content);
  } catch (error) {
    if (!verified) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    throw error;
  }
}
