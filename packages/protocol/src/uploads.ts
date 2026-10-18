import { z } from 'zod';

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
export const attachmentIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const attachmentSchema = z.object({
  id: attachmentIdSchema, name: z.string().min(1).max(255), size: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
  mimeType: z.string().max(255), sha256: attachmentIdSchema,
});
export type Attachment = z.infer<typeof attachmentSchema>;
