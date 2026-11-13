import { z } from 'zod';

export const PROJECT_TRANSFER_CHUNK_BYTES = 512 * 1024;
export const MAX_PROJECT_TRANSFER_BYTES = 4 * 1024 * 1024 * 1024;
export const defaultProjectTransferExclusions = ['node_modules', '.venv', 'venv', '__pycache__', '.cache', '.next', '.nuxt', '.turbo', '.gradle', 'build', 'dist', '.local'];
export const projectTransferOptionsSchema = z.object({
  includeGit: z.boolean(), includeLocalFiles: z.boolean(),
  excludedDirectories: z.array(z.string().min(1).max(100).regex(/^[^/\\\x00-\x1f:]+$/)).max(100),
  note: z.string().max(20000),
}).strict();
export const projectTransferCreateSchema = z.object({
  id: z.string().uuid(), sourceDeviceId: z.string().min(1).max(160), projectId: z.string().min(1).max(160),
  targetDeviceId: z.string().min(1).max(160), parentId: z.string().min(1).max(160),
  relativePath: z.string().min(1).max(100), options: projectTransferOptionsSchema,
}).strict();
export const projectTransferPreparationSchema = z.object({
  phase: z.enum(['waiting', 'scanning', 'packing', 'verifying', 'checksumming']),
  reason: z.enum(['', 'project-active', 'runtime-refresh', 'agent-busy']),
  blockers: z.array(z.object({id: z.string().min(1).max(160), title: z.string().max(200),
    reason: z.enum(['running', 'approval', 'subagent'])}).strict()).max(5),
  files: z.number().int().min(0).max(100000), directories: z.number().int().min(0).max(100000),
  processedFiles: z.number().int().min(0).max(100000),
  processedBytes: z.number().int().min(0).max(MAX_PROJECT_TRANSFER_BYTES),
  totalBytes: z.number().int().min(0).max(MAX_PROJECT_TRANSFER_BYTES),
  updatedAt: z.number().nonnegative().optional(),
}).strict();
export const projectTransferSchema = z.object({
  id: z.string().uuid(), sourceDeviceId: z.string(), targetDeviceId: z.string(), projectId: z.string(), name: z.string(),
  parentId: z.string(), parentPath: z.string(), relativePath: z.string(), options: projectTransferOptionsSchema,
  state: z.enum(['preparing', 'ready', 'uploading', 'downloading', 'installing', 'received', 'completed', 'failed', 'cancelled']),
  size: z.number().nonnegative(), uploaded: z.number().nonnegative(), downloaded: z.number().nonnegative(),
  sha256: z.string(), files: z.number().int().nonnegative(), directories: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(), excludedSamples: z.array(z.string()).max(30),
  roots: z.array(z.string()).max(20), savedPath: z.string(), targetProjectId: z.string(), code: z.string(),
  createdAt: z.number(), updatedAt: z.number(), expiresAt: z.number(),
  preparation: projectTransferPreparationSchema.optional(),
});
export type ProjectTransfer = z.infer<typeof projectTransferSchema>;
export type ProjectTransferCreate = z.infer<typeof projectTransferCreateSchema>;
export type ProjectTransferOptions = z.infer<typeof projectTransferOptionsSchema>;
