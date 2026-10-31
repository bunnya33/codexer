import { z } from 'zod';

export const DEFAULT_SYNC_THREADS = 20;
// 30 × the 256 KiB per-thread budget leaves room in the 8 MiB message budget.
export const MAX_SYNC_THREADS = 30;
export const agentSettingsSchema = z.object({
  threadLimit: z.number().int().min(1).max(MAX_SYNC_THREADS),
}).strict();
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
