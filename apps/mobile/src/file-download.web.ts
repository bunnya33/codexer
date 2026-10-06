import type { FileInfo } from "../../../packages/protocol/src/files";
import { fileResponse } from "./file-transfer";
import type { FileSource } from "./file-transfer";

export async function downloadFile(
  source: FileSource,
  info: FileInfo,
  signal: AbortSignal,
  _progress: (fraction: number) => void,
): Promise<void> {
  const response = await fileResponse(source, signal);
  const blob = await response.blob();
  if (signal.aborted) throw new Error("file-cancelled");
  if (blob.size !== info.size) throw new Error("invalid-file-response");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = info.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 留出浏览器接收下载的时间，再释放本次文件占用的内存。
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
