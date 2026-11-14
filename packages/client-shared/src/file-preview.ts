import { z } from 'zod';
import { fileInfoSchema, filePayloadSchema, MAX_FILE_BYTES, MAX_FILE_PREVIEW_BYTES, type FileInfo } from '../../protocol/src/files';

// This field belongs to Relay HTTP metadata, not the Agent wire protocol.
export const previewFileInfoSchema = fileInfoSchema.extend({ previewMaxBytes: z.number().int().min(1).max(MAX_FILE_BYTES).optional() });
export const previewFilePayloadSchema = filePayloadSchema.extend({ previewMaxBytes: previewFileInfoSchema.shape.previewMaxBytes });
export type PreviewFileInfo = z.infer<typeof previewFileInfoSchema>;
export function filePreviewLimit(info: FileInfo & { previewMaxBytes?: number }): number {
  return info.previewMaxBytes ?? MAX_FILE_PREVIEW_BYTES;
}
export function filePreviewLimitMessage(info: FileInfo & { previewMaxBytes?: number }): string {
  return `超过${info.previewMaxBytes === undefined ? '' : '服务器的 '}${filePreviewLimit(info) / (1024 * 1024)} MiB 预览上限，请下载原文件查看。`;
}
