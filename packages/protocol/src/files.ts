import { z } from "zod";

export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 256 * 1024;
export const MAX_FILE_PREVIEW_BYTES = 2 * 1024 * 1024;
export const filePathSchema = z.string().min(1).max(4096);
export const fileVersionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const fileInfoSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().min(0).max(MAX_FILE_BYTES),
  version: fileVersionSchema,
});
export type FileInfo = z.infer<typeof fileInfoSchema>;
export const filePayloadSchema = fileInfoSchema.extend({
  offset: z.number().int().min(0).max(MAX_FILE_BYTES).optional(),
  base64: z
    .string()
    .max(Math.ceil(FILE_CHUNK_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .optional(),
});
export type FilePayload = z.infer<typeof filePayloadSchema>;
export const fileRequestSchema = z
  .object({
    type: z.literal("file.request"),
    requestId: z.string().uuid(),
    threadId: z.string().min(1).max(160),
    path: filePathSchema,
    offset: z.number().int().min(0).max(MAX_FILE_BYTES).optional(),
    version: fileVersionSchema.optional(),
  })
  .refine(
    (value) => (value.offset === undefined) === (value.version === undefined),
    "invalid-file-request",
  );
export const fileResponseSchema = z.object({
  type: z.literal("device.file"),
  requestId: z.string().uuid(),
  threadId: z.string().min(1).max(160),
  path: filePathSchema,
  file: filePayloadSchema.nullable(),
  code: z
    .enum([
      "file-not-in-thread",
      "file-unavailable",
      "file-too-large",
      "file-changed",
      "invalid-file-offset",
    ])
    .nullable(),
});
