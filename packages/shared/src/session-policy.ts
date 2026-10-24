import { z } from 'zod';

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 7 * 24 * 60;
export const MAX_IDLE_TIMEOUT_MINUTES = 30 * 24 * 60;
export const DEFAULT_AGENT_SESSION_DAYS = 7;
export const MAX_AGENT_SESSION_DAYS = 36500;
// Keep a numeric expiry for compatibility with existing PC Agent credentials.
export const NEVER_EXPIRES_AT = 8640000000000000;
export const authSettingsSchema = z.object({
  idleTimeoutMinutes: z.number().int().min(1).max(MAX_IDLE_TIMEOUT_MINUTES),
  agentSessionDays: z.number().int().min(0).max(MAX_AGENT_SESSION_DAYS),
}).strict();
export type AuthSettings = z.infer<typeof authSettingsSchema>;
