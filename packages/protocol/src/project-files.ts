import { z } from "zod";
import { filePayloadSchema, fileVersionSchema, MAX_FILE_BYTES } from "./files";
export const projectQuerySchema = z
  .object({
    operation: z.enum(["list", "search", "file"]),
    rootIndex: z.number().int().min(0).max(19),
    path: z.string().max(4096),
    cursor: z.string().max(512).nullable().optional(),
    hidden: z.boolean().optional(),
    query: z.string().min(1).max(256).optional(),
    mode: z.enum(["path", "content"]).optional(),
    caseSensitive: z.boolean().optional(),
    offset: z.number().int().min(0).max(MAX_FILE_BYTES).optional(),
    version: fileVersionSchema.optional(),
  })
  .strict();
export type ProjectQuery = z.infer<typeof projectQuerySchema>;
export const projectPageSchema = z.object({
  kind: z.enum(["list", "search", "file"]),
  entries: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        path: z.string().min(1).max(4096),
        kind: z.enum(["directory", "file"]),
        size: z.number().int().nonnegative(),
        link: z.boolean().optional(),
      }),
    )
    .max(200)
    .optional(),
  matches: z
    .array(
      z.object({
        path: z.string().min(1).max(4096),
        line: z.number().int().min(0),
        text: z.string().max(600),
      }),
    )
    .max(100)
    .optional(),
  file: filePayloadSchema.optional(),
  nextCursor: z.string().max(512).nullable().optional(),
  limited: z.boolean().optional(),
  skipped: z.number().int().nonnegative().optional(),
  scanned: z.number().int().nonnegative().optional(),
});
export type ProjectPage = z.infer<typeof projectPageSchema>;
export const projectResponseSchema = z
  .object({
    type: z.literal("device.project"),
    requestId: z.string().uuid(),
    projectId: z.string().min(1).max(160),
    result: projectPageSchema.nullable(),
    code: z
      .enum([
        "project-not-in-catalog",
        "project-path-invalid",
        "project-path-not-allowed",
        "project-directory-unavailable",
        "project-directory-changed",
        "project-search-expired",
        "project-cancelled",
        "file-unavailable",
        "file-too-large",
        "file-changed",
        "invalid-file-offset",
      ])
      .nullable(),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value.result)).length <= 512 * 1024,
    "project-response-too-large",
  );
