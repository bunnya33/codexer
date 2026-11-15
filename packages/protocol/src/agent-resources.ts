import { z } from 'zod';

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const agentProcessResourcesSchema = z.object({
  pid: z.number().int().positive(),
  name: z.enum(['Codexer Agent', 'Codex app-server']),
  cpuPercent: z.number().min(0).max(100).nullable(),
  residentBytes: bytes,
  privateBytes: bytes,
  uptimeSeconds: z.number().nonnegative().nullable(),
});
export const agentResourcesSchema = z.object({
  capturedAt: z.number().int().nonnegative(),
  logicalCpus: z.number().int().min(1).max(65536),
  sampleWindowMs: z.number().nonnegative().max(30000).nullable(),
  agent: agentProcessResourcesSchema,
  children: z.array(agentProcessResourcesSchema).max(4),
});
export type AgentResources = z.infer<typeof agentResourcesSchema>;
export type AgentProcessResources = z.infer<typeof agentProcessResourcesSchema>;
export const agentResourcesResponseSchema = z.object({
  type: z.literal('device.resources'),
  requestId: z.string().uuid(),
  resources: agentResourcesSchema,
});
