import { z } from 'zod';

export const DEFAULT_PREVIEW_MIB = 32;
export const MAX_PREVIEW_MIB = 128;
export const previewSettingsSchema = z.object({ maxPreviewMiB: z.number().int().min(1).max(MAX_PREVIEW_MIB) }).strict();
export type PreviewSettings = z.infer<typeof previewSettingsSchema>;
