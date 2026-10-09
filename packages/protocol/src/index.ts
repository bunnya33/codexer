import { z } from "zod";
import { fileResponseSchema } from "./files.js";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_THREAD_BYTES = 256 * 1024;
export const MAX_THREADS = 20;
export const MAX_CATALOG_BYTES = 6 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGES = 4;
export const MAX_SUB_AGENTS = 32;
export const imageIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const imagePayloadSchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  base64: z.string().min(4).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export type ImagePayload = z.infer<typeof imagePayloadSchema>;
export const imageRefSchema = z.object({ id: imageIdSchema, name: z.string().max(255), source: z.string().max(4096).optional() });
export type ImageRef = z.infer<typeof imageRefSchema>;
export const imageRequestSchema = z.object({ type: z.literal("image.request"), requestId: z.string().uuid(), threadId: z.string().min(1).max(160), imageId: imageIdSchema });
export function jsonBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).length; }
const boundedRecord = (bytes: number) => z.record(z.string().max(200), z.unknown()).refine(value => jsonBytes(value) <= bytes, "payload-too-large");
export const idSchema = z.string().min(1).max(160);
const seqSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timingFields = {
  startedAtMs: seqSchema.optional(),
  completedAtMs: seqSchema.optional(),
  durationMs: seqSchema.optional(),
};
export const tokenBreakdownSchema = z.object({
  totalTokens: seqSchema,
  inputTokens: seqSchema,
  cachedInputTokens: seqSchema,
  outputTokens: seqSchema,
  cacheWriteInputTokens: seqSchema.optional(),
  reasoningOutputTokens: seqSchema.optional(),
}).refine(value => value.cachedInputTokens <= value.inputTokens && (value.reasoningOutputTokens ?? 0) <= value.outputTokens, "invalid-token-breakdown");
export type TokenBreakdown = z.infer<typeof tokenBreakdownSchema>;
export const turnTokenUsageSchema = tokenBreakdownSchema.safeExtend({
  state: z.enum(["running", "complete", "partial"]),
  model: z.string().min(1).max(200).optional(),
});
export type TurnTokenUsage = z.infer<typeof turnTokenUsageSchema>;
export const modelSettingsSchema = z.object({
  model: z.string().min(1).max(200).nullable(),
  modelProvider: z.string().max(200).nullable(),
  reasoningEffort: z.string().max(80).nullable(),
  collaborationMode: z.enum(["default", "plan"]).nullable().optional(),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
export const modelOptionSchema = z.object({
  model: z.string().min(1).max(200),
  displayName: z.string().max(300),
  supportedReasoningEfforts: z.array(z.string().max(80)).max(20),
  defaultReasoningEffort: z.string().max(80),
});
export type ModelOption = z.infer<typeof modelOptionSchema>;
const turnTimingFields = {
  ...timingFields,
  tokenUsage: turnTokenUsageSchema.optional(),
  itemsTruncatedBefore: z.boolean().optional(),
  itemsTruncatedAfter: z.boolean().optional(),
  previousMessage: z.object({ id: idSchema, startedAtMs: seqSchema.optional(), completedAtMs: seqSchema.optional() }).optional(),
  fileChanges: z.array(z.object({ path: z.string().max(1000), additions: seqSchema, deletions: seqSchema, diff: z.string().max(8192), truncated: z.boolean() })).max(40).optional(),
};

export const requestSchema = z.object({
  id: idSchema,
  kind: z.enum(["commandApproval", "fileApproval", "permissionsApproval", "userInput", "mcpElicitation", "unsupported"]),
  turnId: idSchema.nullable(),
  command: z.string().max(16384).optional(),
  reason: z.string().max(8192).optional(),
  details: boundedRecord(16384),
  detailsTruncated: z.boolean(),
  respondable: z.boolean(),
});
export type InteractiveRequest = z.infer<typeof requestSchema>;

export const subAgentSchema = z.object({
  threadId: idSchema,
  parentThreadId: idSchema.optional(),
  name: z.string().max(256).optional(),
  role: z.string().max(256).optional(),
  path: z.string().max(1000).optional(),
  task: z.string().max(2000).optional(),
  model: z.string().max(200).optional(),
  status: z.enum(["pendingInit", "running", "idle", "interrupted", "completed", "errored", "shutdown", "notFound", "unknown"]),
  statusSource: z.enum(["reported", "activity", "thread"]),
  message: z.string().max(2000).optional(),
  truncated: z.boolean().optional(),
});
export type RemoteSubAgent = z.infer<typeof subAgentSchema>;
const subAgentsSchema = z.array(subAgentSchema).max(MAX_SUB_AGENTS)
  .refine(agents => new Set(agents.map(agent => agent.threadId)).size === agents.length, "duplicate-sub-agent");

const itemSchema = z.object({
  id: idSchema,
  type: z.string().max(100),
  status: z.string().max(80).optional(),
  phase: z.enum(["commentary", "final_answer"]).optional(),
  questionRequestId: idSchema.optional(),
  userMessageParts: z.array(z.discriminatedUnion('type', [
    z.object({type: z.literal('text'), text: z.string().max(32000)}),
    z.object({type: z.literal('questionAnswer'), question: z.string().max(8192), answer: z.string().max(8192)}),
  ])).max(40).optional(),
  ...timingFields,
  text: z.string().max(4096).optional(),
  command: z.string().max(4096).optional(),
  output: z.string().max(8192).optional(),
  tool: z.string().max(300).optional(),
  subAgents: subAgentsSchema.optional(),
  files: z.array(z.string().max(1000)).max(40).optional(),
  fileOperations: z.array(z.object({ path: z.string().max(1000), kind: z.enum(['add', 'update', 'delete', 'unknown']) })).max(40).optional(),
  images: z.array(imageRefSchema).max(8).optional(),
  truncated: z.boolean(),
});
export type RemoteItem = z.infer<typeof itemSchema>;

export const threadSchema = z.object({
  id: idSchema,
  title: z.string().max(1000),
  cwd: z.string().max(4096).nullable(),
  status: z.enum(["notLoaded", "idle", "active", "systemError", "unavailable"]),
  activeFlags: z.array(z.string().max(100)).max(20),
  ownerAvailable: z.boolean(),
  truncated: z.boolean(),
  revision: seqSchema,
  activeTurnId: idSchema.nullable(),
  queuedMessages: z.array(z.object({ id: idSchema, text: z.string().max(1000), imageCount: z.number().int().min(0).max(MAX_IMAGES), createdAt: seqSchema, status: z.enum(["queued", "sending", "failed"]) })).max(20).optional(),
  updatedAt: z.number(),
  settings: modelSettingsSchema.optional(),
  subAgents: subAgentsSchema.optional(),
  subAgentsTruncated: z.boolean().optional(),
  turns: z.array(z.object({
    id: idSchema,
    status: z.string().max(80),
    ...turnTimingFields,
    items: z.array(itemSchema).max(20),
    plan: z.array(z.object({ step: z.string().max(2000), status: z.string().max(80) })).max(60),
    diff: z.string().max(16384),
    truncated: z.boolean(),
  })).max(2),
  requests: z.array(requestSchema).max(40),
  tokenUsage: boundedRecord(4096).nullable(),
}).refine(value => jsonBytes(value) <= MAX_THREAD_BYTES, "thread-too-large");
export type RemoteThread = z.infer<typeof threadSchema>;

export const catalogSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  deviceId: idSchema,
  generatedAt: z.number(),
  projects: z.array(z.object({ id: idSchema, name: z.string().max(1000), roots: z.array(z.string().max(4096)).max(20), position: z.number().int(), updatedAt: z.number() })).max(1000),
  threads: z.array(z.object({ id: idSchema, title: z.string().max(1000), cwd: z.string().max(4096).nullable(), projectId: idSchema.nullable(), updatedAt: z.number(), archived: z.boolean(), settings: modelSettingsSchema.optional() })).max(10000),
  models: z.array(modelOptionSchema).max(200).optional(),
}).refine(value => jsonBytes(value) <= MAX_CATALOG_BYTES, "catalog-too-large")
  .refine(value => new Set(value.projects.map(project => project.id)).size === value.projects.length && new Set(value.threads.map(thread => thread.id)).size === value.threads.length, "duplicate-catalog-id");
export type DeviceCatalog = z.infer<typeof catalogSchema>;

const historyItemSchema = itemSchema.extend({ text: z.string().max(32000).optional(), command: z.string().max(8192).optional(), output: z.string().max(32000).optional() });
export const historyTurnSchema = z.object({ id: idSchema, status: z.string().max(80), ...turnTimingFields, items: z.array(historyItemSchema).max(80), truncated: z.boolean() });
export type HistoryTurn = z.infer<typeof historyTurnSchema>;
export const historyPageSchema = z.object({ threadId: idSchema, turns: z.array(historyTurnSchema).max(5), nextCursor: z.string().max(2048).nullable(), generatedAt: z.number() }).refine(value => jsonBytes(value) <= MAX_CATALOG_BYTES, "history-too-large");
export type HistoryPage = z.infer<typeof historyPageSchema>;
export const historyRequestSchema = z.object({ type: z.literal("history.request"), requestId: idSchema, threadId: idSchema, cursor: z.string().max(2048).nullable() });

export const snapshotSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  deviceId: idSchema,
  epoch: idSchema,
  lastSeq: seqSchema,
  generatedAt: z.number(),
  hostname: z.string().max(300),
  platform: z.enum(["win32", "darwin", "linux"]),
  runtime: z.object({
    kind: z.enum(["official-desktop-ipc", "official-app-server"]),
    connected: z.boolean(),
    experimental: z.literal(true),
    capabilities: z.object({ observe: z.boolean(), startTurn: z.boolean(), interrupt: z.boolean(), approvals: z.boolean(), userInput: z.boolean(), modelUpdate: z.boolean().optional(), effortUpdate: z.boolean().optional(), collaborationModeUpdate: z.boolean().optional(), images: z.boolean().optional(), subAgents: z.boolean().optional() }),
  }),
  threads: z.record(idSchema, threadSchema).refine(threads => Object.keys(threads).length <= MAX_THREADS && Object.entries(threads).every(([id, thread]) => id === thread.id)),
});
export type DeviceSnapshot = z.infer<typeof snapshotSchema>;

export const eventSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  deviceId: idSchema,
  epoch: idSchema,
  seq: seqSchema,
  timestamp: z.number(),
  change: z.discriminatedUnion("type", [
    z.object({ type: z.literal("thread.updated"), thread: threadSchema }),
    z.object({ type: z.literal("thread.removed"), threadId: idSchema }),
    z.object({ type: z.literal("runtime.status"), connected: z.boolean(), kind: z.enum(["official-desktop-ipc", "official-app-server"]).optional() }),
  ]),
});
export type RemoteEvent = z.infer<typeof eventSchema>;

export const commandSchema = z.object({
  commandId: idSchema,
  deviceId: idSchema,
  expectedEpoch: idSchema,
  expiresAt: z.number().int(),
  payload: z.discriminatedUnion("type", [
    z.object({ type: z.literal("thread.create"), projectId: idSchema }),
    z.object({ type: z.literal("thread.rename"), threadId: idSchema, name: z.string().trim().min(1).max(1000) }),
    z.object({ type: z.literal("thread.archive"), threadId: idSchema }),
    z.object({ type: z.literal("thread.delete"), threadId: idSchema }),
    z.object({ type: z.literal("thread.watch"), threadId: idSchema }),
    z.object({ type: z.literal("turn.start"), threadId: idSchema, text: z.string().max(32000), images: z.array(imageIdSchema).max(MAX_IMAGES).optional() }).refine(value => value.text.trim().length > 0 || Boolean(value.images?.length), "empty-input"),
    z.object({ type: z.literal("turn.queue"), threadId: idSchema, text: z.string().max(32000), images: z.array(imageIdSchema).max(MAX_IMAGES).optional() }).refine(value => value.text.trim().length > 0 || Boolean(value.images?.length), "empty-input"),
    z.object({ type: z.literal("turn.queue.steer"), threadId: idSchema, turnId: idSchema, queueId: idSchema }),
    z.object({ type: z.literal("turn.queue.remove"), threadId: idSchema, queueId: idSchema }),
    z.object({ type: z.literal("turn.steer"), threadId: idSchema, turnId: idSchema, text: z.string().max(32000), images: z.array(imageIdSchema).max(MAX_IMAGES).optional() }).refine(value => value.text.trim().length > 0 || Boolean(value.images?.length), "empty-input"),
    z.object({ type: z.literal("thread.model.update"), threadId: idSchema, model: z.string().trim().min(1).max(200).refine(value => !/[\s\x00-\x1f]/.test(value), "invalid-model"), expectedModel: z.string().min(1).max(200) }),
    z.object({ type: z.literal("thread.effort.update"), threadId: idSchema, effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]), expectedModel: z.string().min(1).max(200), expectedEffort: z.string().max(80).nullable() }),
    z.object({ type: z.literal("thread.mode.update"), threadId: idSchema, mode: z.enum(["default", "plan"]), expectedMode: z.enum(["default", "plan"]).nullable(), expectedModel: z.string().min(1).max(200), expectedEffort: z.string().max(80).nullable() }),
    z.object({ type: z.literal("turn.interrupt"), threadId: idSchema, turnId: idSchema }),
    z.object({ type: z.literal("approval.respond"), threadId: idSchema, turnId: idSchema, requestId: idSchema, decision: z.enum(["accept", "decline", "cancel"]) }),
    z.object({ type: z.literal("input.respond"), threadId: idSchema, turnId: idSchema, requestId: idSchema, answers: z.record(z.string().max(200), z.object({ answers: z.array(z.string().max(8192)).max(20) })).refine(answers => Object.keys(answers).length <= 20) }),
  ]),
});
export type RemoteCommand = z.infer<typeof commandSchema>;
export const resultSchema = z.object({
  commandId: idSchema,
  deviceId: idSchema,
  status: z.enum(["succeeded", "failed", "unknown"]),
  code: z.string().max(100),
  result: boundedRecord(16384).optional(),
});
export type CommandResult = z.infer<typeof resultSchema>;

export const deviceMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("device.capabilities"), features: z.array(z.enum(["files"])).max(1) }),
  fileResponseSchema,
  z.object({ type: z.literal("device.snapshot"), snapshot: snapshotSchema }),
  z.object({ type: z.literal("device.event"), event: eventSchema }),
  z.object({ type: z.literal("device.catalog"), catalog: catalogSchema }),
  z.object({ type: z.literal("device.history"), requestId: idSchema, threadId: idSchema, page: historyPageSchema.nullable(), code: z.string().max(100).nullable() }),
  z.object({ type: z.literal("device.image"), requestId: z.string().uuid(), threadId: idSchema, imageId: imageIdSchema, image: imagePayloadSchema.nullable() }),
  z.object({ type: z.literal("command.result"), result: resultSchema }),
]);
export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("client.authenticate"), ticket: z.string().min(20).max(200) }),
  z.object({ type: z.literal("client.subscribe"), deviceId: idSchema, epoch: idSchema.optional(), lastSeq: seqSchema.optional() }),
  z.object({ type: z.literal("client.command"), command: commandSchema }),
]);

export function reduceEvent(snapshot: DeviceSnapshot, event: RemoteEvent): DeviceSnapshot {
  if (snapshot.deviceId !== event.deviceId || snapshot.epoch !== event.epoch || event.seq !== snapshot.lastSeq + 1) {
    throw new Error("sequence-gap");
  }
  const threads = new Map(Object.entries(snapshot.threads));
  if (event.change.type === "thread.updated") threads.set(event.change.thread.id, event.change.thread);
  if (event.change.type === "thread.removed") threads.delete(event.change.threadId);
  if (threads.size > MAX_THREADS) throw new Error("thread-limit");
  return {
    ...snapshot,
    generatedAt: event.timestamp,
    lastSeq: event.seq,
    runtime: event.change.type === "runtime.status" ? { ...snapshot.runtime, connected: event.change.connected, kind: event.change.kind ?? snapshot.runtime.kind } : snapshot.runtime,
    threads: Object.fromEntries(threads),
  };
}
