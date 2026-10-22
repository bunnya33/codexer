import {z} from 'zod';

export const MAX_AGENT_INSTALLER_BYTES = 256 * 1024 * 1024;
export const agentVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
export const agentReleaseSchema = z.object({
  id:z.string().uuid(), name:z.string().min(1).max(180), version:z.string().regex(agentVersionPattern),
  size:z.number().int().min(128).max(MAX_AGENT_INSTALLER_BYTES), sha256:z.string().regex(/^[a-f0-9]{64}$/), uploadedAt:z.number().int(),
});
export type AgentRelease = z.infer<typeof agentReleaseSchema>;
