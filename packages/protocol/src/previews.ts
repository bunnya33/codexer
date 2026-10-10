import { z } from 'zod';

export const PREVIEW_CHUNK_BYTES = 64 * 1024;
export const MAX_PREVIEW_RESPONSE_BYTES = 32 * 1024 * 1024;
const id = z.string().uuid();
const base = { requestId: id, threadId: z.string().min(1).max(160) };
const data = z.string().max(Math.ceil(PREVIEW_CHUNK_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const previewRequestSchema = z.object({
  type: z.literal('preview.request'), ...base, origin: z.string().max(2048), path: z.string().max(8192),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
  headers: z.record(z.string().max(100), z.string().max(8192)),
  body: z.string().max(2 * 1024 * 1024).optional(),
});
export const previewSocketSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('preview.ws.open'), ...base, origin: z.string().max(2048), path: z.string().max(8192), protocols: z.array(z.string().max(200)).max(8) }),
  z.object({ type: z.literal('preview.ws.data'), requestId: id, data, binary: z.boolean() }),
  z.object({ type: z.literal('preview.cancel'), requestId: id }),
]);
export const previewResponseSchema = z.object({ type: z.literal('device.preview'), requestId: id, event: z.discriminatedUnion('type', [
  z.object({ type: z.literal('headers'), status: z.number().int().min(100).max(599), headers: z.record(z.string().max(100), z.string().max(16384)) }),
  z.object({ type: z.literal('data'), data }),
  z.object({ type: z.literal('end') }),
  z.object({ type: z.literal('error'), code: z.string().max(100) }),
  z.object({ type: z.literal('ws.open'), protocol: z.string().max(200) }),
  z.object({ type: z.literal('ws.data'), data, binary: z.boolean() }),
  z.object({ type: z.literal('ws.close') }),
]) });
export type PreviewRequest = z.infer<typeof previewRequestSchema>;
export type PreviewResponse = z.infer<typeof previewResponseSchema>;
