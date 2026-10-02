import { z } from 'zod';

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 7 * 24 * 60;
export const MAX_IDLE_TIMEOUT_MINUTES = 30 * 24 * 60;
export const authSettingsSchema = z.object({idleTimeoutMinutes: z.number().int().min(1).max(MAX_IDLE_TIMEOUT_MINUTES)}).strict();
export type AuthSettings = z.infer<typeof authSettingsSchema>;
