import { z } from 'zod';

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
export function isVideoAttachment(value: { name: string; mimeType: string }): boolean {
  return value.mimeType.toLowerCase().startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|mpeg|mpg|3gp|3g2|m2ts|mts|ogv)$/i.test(value.name);
}
export function attachmentByteLimit(value: { name: string; mimeType: string }): number {
  return isVideoAttachment(value) ? MAX_VIDEO_BYTES : MAX_ATTACHMENT_BYTES;
}
export const attachmentIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const attachmentSchema = z.object({
  id: attachmentIdSchema, name: z.string().min(1).max(255), size: z.number().int().min(0).max(MAX_VIDEO_BYTES),
  mimeType: z.string().max(255), sha256: attachmentIdSchema,
}).refine(value => value.size <= attachmentByteLimit(value), 'attachment-too-large');
export type Attachment = z.infer<typeof attachmentSchema>;
