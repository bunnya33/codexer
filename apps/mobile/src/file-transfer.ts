import { MAX_FILE_PREVIEW_BYTES } from "../../../packages/protocol/src/files";
import type { FileInfo } from "../../../packages/protocol/src/files";
import { readableFileText } from "../../../packages/client-shared/src/file-links";

export type FileSource = { uri: string; headers: Record<string, string> };

export function fileError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  const messages: Record<string, string> = {
    "file-not-in-thread": "这个文件没有在当前会话中引用，请刷新会话后重试",
    "file-unavailable": "PC 上的文件不存在或无法读取",
    "file-too-large": "文件超过 512 MB，暂时无法传输",
    "file-changed": "PC 上的文件已更改，请重新打开",
    "file-timeout": "读取文件超时，请检查 PC 的网络后重试",
    "agent-update-required": "请更新 PC 连接器后打开文件",
    "device-offline": "PC 已离线，连接后才能获取文件",
    "files-busy": "文件传输繁忙，请稍后重试",
    'preview-not-in-thread': '这个网页地址尚未出现在当前会话中，请刷新会话后重试',
    'preview-unavailable': '电脑上的网页服务暂不可用，请确认服务仍在运行',
    'preview-expired': '预览已到期，请点击刷新重新打开',
    'preview-revoked': '预览登录已失效，请重新登录后打开',
    'previews-busy': '预览连接较多，请关闭部分预览后重试',
    'preview-timeout': '网页加载超时，请检查电脑上的服务后重试',
    'preview-response-too-large': '网页资源超过预览大小限制',
    'preview-external-redirect': '这个网页跳转到了另一个服务，请使用对应服务的预览地址',
    unauthorized: "登录已过期，请重新登录",
    "thread-not-in-catalog": "当前会话已不可用",
    "invalid-file-response": "文件传输不完整，请重试",
  };
  return (
    messages[code] ??
    (code === "Failed to fetch" ? "网络暂不可用，请重试" : code || "文件读取失败，请重试")
  );
}

export async function fileResponse(source: FileSource, signal: AbortSignal): Promise<Response> {
  const response = await fetch(source.uri, { headers: source.headers, signal });
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(result.error ?? `HTTP ${response.status}`);
  }
  return response;
}

export async function previewFile(
  source: FileSource,
  info: FileInfo,
  signal: AbortSignal,
): Promise<string> {
  if (info.size > MAX_FILE_PREVIEW_BYTES) throw new Error("文件较大，请下载后查看");
  const response = await fileResponse(source, signal);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (signal.aborted) throw new Error("file-cancelled");
  if (bytes.length !== info.size) throw new Error("invalid-file-response");
  try {
    return readableFileText(bytes, info.name);
  } catch {
    throw new Error("无法按 UTF-8 文本读取，请下载后查看");
  }
}
