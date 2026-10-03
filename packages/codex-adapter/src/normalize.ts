import type { HistoryPage, HistoryTurn, InteractiveRequest, ModelSettings, RemoteItem, RemoteThread } from "../../protocol/src/index.js";
import { jsonBytes, MAX_CATALOG_BYTES, MAX_THREAD_BYTES, modelSettingsSchema } from "../../protocol/src/index.js";
import { userPresentation } from "../../protocol/src/user-presentation.js";
import type { UserMessagePart } from '../../protocol/src/user-presentation.js';
import type { ImageRegistry } from "./images.js";
import { asyncInputRequests, asyncQuestionRequestId } from './async-input.js';

export type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
export function modelSettings(state: RecordValue): ModelSettings | undefined {
  const settings = record(state.latestThreadSettings);
  const collaboration = record(settings.collaborationMode ?? state.latestCollaborationMode);
  const mode = record(collaboration.settings);
  const parsed = modelSettingsSchema.safeParse({
    model: settings.model ?? state.latestModel ?? state.model ?? mode.model ?? null,
    modelProvider: settings.modelProvider ?? state.modelProvider ?? null,
    reasoningEffort: settings.effort ?? state.latestReasoningEffort ?? state.reasoningEffort ?? mode.reasoning_effort ?? null,
    collaborationMode: collaboration.mode === "plan" || collaboration.mode === "default" ? collaboration.mode : null,
  });
  return parsed.success ? parsed.data : undefined;
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function displayText(value: string): string { return value.toWellFormed().replaceAll('\0', '\uFFFD'); }
function text(value: unknown, max: number): string { return typeof value === "string" ? displayText(value.slice(0, max)) : ""; }
function boundedMessageParts(parts: UserMessagePart[], limit: number): UserMessagePart[] {
  const bounded: UserMessagePart[] = [];
  for (const part of parts) {
    if (limit <= 0 || bounded.length >= 40) break;
    if (part.type === 'text') {
      const value = text(part.text, limit); limit -= value.length;
      if (value.trim()) bounded.push({type: 'text', text: value});
    } else {
      const question = text(part.question, limit); limit -= question.length;
      const answer = text(part.answer, limit); limit -= answer.length;
      bounded.push({type: 'questionAnswer', question, answer});
    }
  }
  return bounded;
}
function milliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function turnTiming(turn: RecordValue) {
  const startedAtMs = milliseconds(turn.turnStartedAtMs) ?? milliseconds(typeof turn.startedAt === "number" ? turn.startedAt * 1000 : undefined);
  const durationMs = milliseconds(turn.durationMs);
  const completedAtMs = milliseconds(turn.completedAtMs) ?? milliseconds(typeof turn.completedAt === "number" ? turn.completedAt * 1000 : undefined)
    ?? (turn.status !== "inProgress" && startedAtMs !== undefined && durationMs !== undefined ? milliseconds(startedAtMs + durationMs) : undefined);
  return { ...(startedAtMs !== undefined ? { startedAtMs } : {}), ...(completedAtMs !== undefined ? { completedAtMs } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
}
function messageBoundary(item: RemoteItem): HistoryTurn["previousMessage"] {
  if (!["userMessage", "steeringUserMessage", "agentMessage"].includes(item.type)) return undefined;
  return { id: item.id, ...(item.startedAtMs !== undefined ? { startedAtMs: item.startedAtMs } : {}), ...(item.completedAtMs !== undefined ? { completedAtMs: item.completedAtMs } : {}) };
}
function visibleTurnItems(items: unknown[], limit: number): unknown[] {
  if (items.length <= limit) return items;
  const userIndexes = items.flatMap((value, index) => ["userMessage", "steeringUserMessage"].includes(String(record(value).type)) ? [index] : []);
  const retainedUsers = userIndexes.length > limit ? [userIndexes[0]!, ...userIndexes.slice(-(limit - 1))] : userIndexes;
  const selected = new Set(retainedUsers);
  for (let index = items.length - 1; index >= 0 && selected.size < limit; index--) selected.add(index);
  return [...selected].sort((a, b) => a - b).map(index => items[index]);
}
export function markTruncatedStart(turn: Pick<HistoryTurn, "itemsTruncatedBefore" | "previousMessage">, removed: RemoteItem | undefined): void {
  turn.itemsTruncatedBefore = true;
  const boundary = removed && messageBoundary(removed);
  if (boundary) turn.previousMessage = boundary;
}
export function withItemTimings(turn: RecordValue, entries: unknown[]): RecordValue {
  const itemTimingsById = { ...record(turn.itemTimingsById) };
  for (const value of entries) {
    const entry = record(value), item = record(entry.item);
    if (entry.turnId === turn.id && typeof item.id === "string") itemTimingsById[item.id] = { startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs };
  }
  return { ...turn, itemTimingsById };
}
export function desktopTurns(state: RecordValue): RecordValue[] {
  const container = record(state.turnHistory);
  if (container.kind !== "canonical") return array(state.turns).map(record);
  const history = record(container.history);
  const entities = record(history.entitiesByKey);
  return array(history.islands).flatMap(island => array(record(island).entries).map(entry => record(entities[String(record(entry).value)])));
}
function itemFileEntries(item: RecordValue): RecordValue[] {
  return Array.isArray(item.changes) ? item.changes.map(record) : Object.entries(record(item.changes)).map(([path, change]) => ({ ...record(change), path }));
}
function normalizeItem(value: unknown, turn: RecordValue, textLimit = 4096, outputLimit = 8192, images?: ImageRegistry, threadId = ""): RemoteItem {
  const item = record(value);
  const parts = array(item.content ?? item.input).map(record);
  const imageRefs = images?.references(threadId, item) ?? [];
  // Decode internal reply envelopes before applying the visible text limit.
  const content = parts.map(part => typeof part.text === 'string' ? part.text : '').filter(Boolean).join("\n");
  const summary = array(item.summary).filter((part): part is string => typeof part === "string").join("\n\n");
  const rawBody = item.type === "reasoning" ? summary : typeof item.text === "string" ? item.text : content;
  const presentation: ReturnType<typeof userPresentation> = ["userMessage", "steeringUserMessage"].includes(String(item.type)) ? userPresentation(rawBody) : { body: rawBody, files: [] };
  const body = presentation.body;
  const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
  const paths = Array.isArray(item.changes) ? item.changes.map(change => String(record(change).path ?? "")).filter(Boolean) : Object.keys(record(item.changes));
  const files = [...paths, ...presentation.files.filter(file => !imageRefs.some(ref => ref.name === file))].slice(0, 40).map(path => path.slice(0, 1000));
  const fileOperations: NonNullable<RemoteItem['fileOperations']> = item.type === 'fileChange' ? itemFileEntries(item).filter(change => typeof change.path === 'string' && change.path).slice(0, 40).map(change => {
    const kind = typeof change.kind === 'string' ? change.kind : record(change.kind).type ?? change.type;
    return { path: text(change.path, 1000), kind: kind === 'add' || kind === 'update' || kind === 'delete' ? kind : 'unknown' };
  }) : [];
  const timing = record(record(turn.itemTimingsById)[String(item.id)]);
  const startedAtMs = milliseconds(timing.startedAtMs) ?? milliseconds(item.startedAtMs)
    ?? milliseconds(record(turn.aeonAssistantMessageStartedAtMsById)[String(item.id)])
    ?? milliseconds(record(turn.commandExecutionStartedAtMsById)[String(item.id)]);
  const durationMs = milliseconds(item.durationMs);
  const completedAtMs = milliseconds(timing.completedAtMs) ?? milliseconds(item.completedAtMs);
  const questionRequestId = asyncQuestionRequestId(item);
  return {
    id: text(item.id, 160) || "unknown",
    type: text(item.type, 100) || "unknown",
    ...(typeof item.status === "string" ? { status: text(item.status, 80) } : {}),
    ...(item.phase === "commentary" || item.phase === "final_answer" ? { phase: item.phase } : {}),
    ...(questionRequestId ? { questionRequestId } : {}),
    ...(presentation.parts ? {userMessageParts: boundedMessageParts(presentation.parts, textLimit)} : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(body ? { text: text(body, textLimit) } : {}),
    ...(typeof item.command === "string" ? { command: text(item.command, textLimit === 4096 ? 4096 : 8192) } : {}),
    ...(output ? { output: displayText(output.slice(-outputLimit)) } : {}),
    ...(typeof item.tool === "string" ? { tool: text(item.tool, 300) } : {}),
    ...(files.length ? { files } : {}),
    ...(fileOperations.length ? { fileOperations } : {}),
    ...(imageRefs.length ? { images: imageRefs } : {}),
    truncated: body.length > textLimit || output.length > outputLimit || parts.some(part => typeof part.text === "string" && part.text.length > textLimit) || typeof item.command === "string" && item.command.length > (textLimit === 4096 ? 4096 : 8192) || paths.length + presentation.files.length > 40 || paths.some(path => path.length > 1000),
  };
}
function fileChanges(items: unknown[]): HistoryTurn["fileChanges"] {
  const changes = new Map<string, NonNullable<HistoryTurn["fileChanges"]>[number]>();
  for (const value of items) {
    const item = record(value);
    if (item.type !== "fileChange" || item.status === "inProgress" || item.status === "failed" || item.status === "declined") continue;
    const entries = itemFileEntries(item);
    for (const change of entries) {
      const path = text(change.path, 1000);
      if (!path || !changes.has(path) && changes.size >= 40) continue;
      const source = [change.diff, change.unifiedDiff, change.unified_diff, change.content].find((value): value is string => typeof value === "string") ?? "";
      const kind = record(change.kind).type ?? change.type;
      const contentLines = source ? source.replace(/\n$/, "").split("\n") : [];
      // Official add/delete changes carry file content rather than a unified diff.
      const diff = kind === "add" || kind === "delete" ? contentLines.map(line => `${kind === "add" ? "+" : "-"}${line}`).join("\n") : source;
      const previous = changes.get(path);
      const lines = diff.split("\n");
      let inHunk = kind === "add" || kind === "delete";
      let additions = 0, deletions = 0;
      for (const line of lines) {
        if (line.startsWith("@@ ")) { inHunk = true; continue; }
        if (line.startsWith("diff --git ")) { inHunk = false; continue; }
        if (!inHunk && (line.startsWith("+++ ") || line.startsWith("--- "))) continue;
        if (line.startsWith("+")) additions++;
        if (line.startsWith("-")) deletions++;
      }
      const combined = [previous?.diff, diff].filter(Boolean).join("\n");
      changes.set(path, { path, additions: (previous?.additions ?? 0) + additions,
        deletions: (previous?.deletions ?? 0) + deletions,
        diff: text(combined, 8192), truncated: Boolean(previous?.truncated || combined.length > 8192) });
    }
  }
  return changes.size ? [...changes.values()] : undefined;
}
export function normalizeHistoryTurn(value: unknown, images?: ImageRegistry, threadId = ""): HistoryTurn {
  const turn = record(value);
  const items = array(turn.items);
  const changes = fileChanges(items);
  return {
    id: text(turn.id, 160) || "unknown",
    status: text(turn.status, 80) || "unknown",
    ...turnTiming(turn),
    items: visibleTurnItems(items, 80).map(item => normalizeItem(item, turn, 32000, 32000, images, threadId)),
    ...(changes ? { fileChanges: changes } : {}),
    ...(items.length > 80 ? { itemsTruncatedBefore: true } : {}),
    truncated: items.length > 80,
  };
}
export function normalizeRequests(state: RecordValue): InteractiveRequest[] {
  const requests: InteractiveRequest[] = array(state.requests).filter(value => record(value).completed !== true).slice(0, 40).map(value => {
    const request = record(value);
    const params = record(request.params);
    const method = String(request.method);
    const kind: InteractiveRequest["kind"] = method === "item/commandExecution/requestApproval" ? "commandApproval" : method === "item/fileChange/requestApproval" ? "fileApproval" : method === "item/permissions/requestApproval" ? "permissionsApproval" : method === "item/tool/requestUserInput" ? "userInput" : method === "mcpServer/elicitation/request" ? "mcpElicitation" : "unsupported";
    let details: RecordValue = {};
    for (const key of ["questions", "isBlocking", "autoResolutionMs", "changes", "permissions", "availableDecisions", "networkApprovalContext", "requestedSchema", "message", "mode", "kind", "cwd", "commandActions", "additionalPermissions", "grantRoot", "approvalId", "environmentId"]) {
      if (params[key] !== undefined) details[key] = params[key];
    }
    const detailsTruncated = jsonBytes(details) > 16384 || typeof params.command === "string" && params.command.length > 16384 || typeof params.reason === "string" && params.reason.length > 8192;
    if (detailsTruncated) details = {};
    return { id: String(request.id).slice(0, 160), kind, turnId: typeof params.turnId === "string" ? params.turnId : null, ...(typeof params.command === "string" ? { command: text(params.command, 16384) } : {}), ...(typeof params.reason === "string" ? { reason: text(params.reason, 8192) } : {}), details, detailsTruncated, respondable: !detailsTruncated && ["commandApproval", "fileApproval", "userInput"].includes(kind) };
  });
  return [...requests, ...asyncInputRequests(desktopTurns(state))].slice(0, 40);
}
export function normalizeThread(state: RecordValue, revision: number, images?: ImageRegistry): RemoteThread {
  const settings = modelSettings(state);
  const turns = desktopTurns(state);
  const active = [...turns].reverse().find(turn => turn.status === "inProgress");
  const activeId = active?.turnId ?? active?.id;
  const runtime = record(state.threadRuntimeStatus);
  const runtimeType = runtime.type;
  const status = runtimeType === "active" || runtimeType === "idle" || runtimeType === "systemError" || runtimeType === "notLoaded" ? runtimeType : "unavailable";
  const thread: RemoteThread = {
    id: String(state.id), title: text(state.title, 1000) || "Untitled", cwd: typeof state.cwd === "string" ? text(state.cwd, 4096) : null,
    status, activeFlags: array(runtime.activeFlags).map(flag => text(typeof flag === "string" ? flag : String(record(flag).type ?? "unknown"), 100)).slice(0, 20), ownerAvailable: true, truncated: turns.length > 2 || array(state.requests).length > 40, revision,
    activeTurnId: status === "active" && typeof activeId === "string" ? activeId : null,
    updatedAt: typeof state.updatedAt === "number" ? state.updatedAt : Date.now(),
    ...(settings ? { settings } : {}),
    turns: turns.slice(-2).map(turn => {
      const items = array(turn.items);
      const changes = fileChanges(items);
      const precedingItem = items.slice(0, -20).reverse().find(item => ["userMessage", "steeringUserMessage", "agentMessage"].includes(String(record(item).type)));
      const preceding = precedingItem ? messageBoundary(normalizeItem(precedingItem, turn)) : undefined;
      const latestPlan = [...items].reverse().find(item => record(item).type === "todo-list");
      const plan = record(turn.plan ?? turn.turnPlan ?? latestPlan);
      const steps = Array.isArray(turn.plan) ? turn.plan : array(plan.plan ?? plan.steps);
      const diff = typeof turn.diff === "string" ? turn.diff : "";
      return {
        id: typeof turn.turnId === "string" ? turn.turnId : String(turn.id ?? "unknown"), status: text(turn.status, 80) || "unknown",
        ...turnTiming(turn),
        ...(changes ? { fileChanges: changes } : {}),
        ...(items.length > 20 ? { itemsTruncatedBefore: true } : {}),
        ...(preceding ? { previousMessage: preceding } : {}),
        items: visibleTurnItems(items, 20).map(item => normalizeItem(item, turn, 4096, 8192, images, String(state.id))), plan: steps.slice(0, 60).map(step => ({ step: text(record(step).step, 2000), status: text(record(step).status, 80) })),
        diff: text(diff, 16384), truncated: items.length > 20 || diff.length > 16384 || steps.length > 60,
      };
    }),
    requests: normalizeRequests(state), tokenUsage: state.latestTokenUsageInfo && jsonBytes(state.latestTokenUsageInfo) <= 4096 ? record(state.latestTokenUsageInfo) : null,
  };
  return boundThread(thread);
}
export function boundThread(thread: RemoteThread): RemoteThread {
  // Keep a full-device snapshot below the transport limit, including escaped Unicode.
  while (jsonBytes(thread) > MAX_THREAD_BYTES) {
    thread.truncated = true;
    const change = thread.turns.flatMap(turn => turn.fileChanges ?? []).find(change => change.diff.length);
    if (change) { change.diff = ""; change.truncated = true; continue; }
    const turn = thread.turns.find(value => value.items.some(item => !["userMessage", "steeringUserMessage"].includes(item.type)) || value.diff.length > 0 || value.plan.length > 0)
      ?? thread.turns.find(value => value.items.length > 0);
    if (turn) {
      const removable = turn.items.findIndex(item => !["userMessage", "steeringUserMessage"].includes(item.type));
      if (removable >= 0) markTruncatedStart(turn, turn.items.splice(removable, 1)[0]);
      else if (turn.diff.length) turn.diff = "";
      else if (turn.plan.length) turn.plan.shift();
      else markTruncatedStart(turn, turn.items.shift());
      turn.truncated = true;
    } else if (thread.requests.length) thread.requests.pop();
    else break;
  }
  return thread;
}
export function boundHistoryPage(page: HistoryPage): HistoryPage {
  while (jsonBytes(page) > MAX_CATALOG_BYTES) {
    const change = page.turns.flatMap(turn => turn.fileChanges ?? []).find(change => change.diff.length);
    if (change) { change.diff = ""; change.truncated = true; continue; }
    const largest = page.turns.filter(turn => turn.items.some(item => !["userMessage", "steeringUserMessage"].includes(item.type))).sort((a, b) => b.items.length - a.items.length)[0]
      ?? page.turns.filter(turn => turn.items.length).sort((a, b) => b.items.length - a.items.length)[0];
    if (!largest) throw new Error("history-too-large");
    const removable = largest.items.findIndex(item => !["userMessage", "steeringUserMessage"].includes(item.type));
    markTruncatedStart(largest, largest.items.splice(removable < 0 ? 0 : removable, 1)[0]); largest.truncated = true;
  }
  return page;
}
