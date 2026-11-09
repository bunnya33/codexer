import type { HistoryTurn, RemoteItem } from "../../protocol/src/index.js";
import { subAgentName, subAgentStatusLabel } from './sub-agents.js';

export type ActivityBlock = {
  kind: "activity";
  id: string;
  items: RemoteItem[];
  state: "running" | "completed" | "interrupted" | "failed" | "recorded";
  startedAtMs?: number;
  durationMs?: number;
};
export type ConversationBlock = { kind: "message"; item: RemoteItem } | ActivityBlock;
export type ExecutionSection = { kind: "execution"; id: string; items: RemoteItem[]; running: boolean };
export type ActivitySection = { kind: "message"; item: RemoteItem } | ExecutionSection;

function toolName(item: RemoteItem) {
  return (item.tool ?? '').replace(/^mcp__.+?__/, '');
}
const chatToolActions: Record<string, string> = {
  read_thread: '读取聊天', list_threads: '查看聊天列表', list_archived_threads: '查看归档聊天',
  wait_threads: '等待聊天', create_thread: '创建聊天', fork_thread: '分支聊天',
  set_thread_title: '重命名聊天', set_thread_archived: '归档聊天', delete_thread: '删除聊天',
  set_thread_read_state: '更新聊天阅读状态', set_thread_pinned: '更新聊天置顶状态',
  navigate_to_codex_page: '打开聊天', send_message_to_thread: '发送聊天消息',
  list_projects: '查看项目列表', list_artifacts: '查看附件', open_in_codex: '打开预览',
  load_workspace_dependencies: '加载工作区依赖',
};
function toolAction(item: RemoteItem) {
  const name = toolName(item);
  if (!item.toolServer || item.toolServer === 'codex_app' || item.tool?.startsWith('mcp__codex_app__')) {
    if (chatToolActions[name]) return chatToolActions[name];
  }
  if (item.toolServer === 'cua_repl' || item.tool?.startsWith('mcp__cua_repl__')) return '操作浏览器';
  if (item.type === 'webSearch') return '搜索网页';
  if (item.type === 'imageView') return '查看图片';
  if (item.type === 'contextCompaction') return '压缩上下文';
  if (item.type === 'sleep') return '等待';
  return undefined;
}
export function executionItemIcon(item: RemoteItem | undefined): 'agent' | 'reasoning' | 'file' | 'command' | 'browser' | 'chat' | 'image' | 'clock' | 'search' | 'compaction' | 'tool' {
  if (item?.subAgents?.length) return 'agent';
  if (!item || item.type === 'reasoning') return 'reasoning';
  if (item.command || item.type === 'commandExecution') return 'command';
  if (item.files?.length || item.fileOperations?.length || item.type === 'fileChange') return 'file';
  if (item.toolServer === 'cua_repl' || item.tool?.startsWith('mcp__cua_repl__')) return 'browser';
  if (toolAction(item) && /聊天/.test(toolAction(item)!)) return 'chat';
  if (item.type === 'imageView') return 'image';
  if (item.type === 'sleep') return 'clock';
  if (item.type === 'webSearch') return 'search';
  if (item.type === 'contextCompaction') return 'compaction';
  return 'tool';
}
function itemActive(item: RemoteItem, running: boolean) {
  if (item.status === 'inProgress' || item.status === 'running') return running && item.completedAtMs === undefined;
  return running && item.completedAtMs === undefined && item.durationMs === undefined && !['completed', 'failed', 'interrupted', 'cancelled', 'declined'].includes(item.status ?? '');
}

/** Keep prose visible and collapse consecutive execution records between messages.
 * IDs follow the preceding message, so appending streamed steps retains expansion state.
 */
export function activitySections(block: ActivityBlock): ActivitySection[] {
  const sections: ActivitySection[] = [];
  let boundary = 'start', group: ExecutionSection | undefined;
  for (const item of block.items) {
    if (messageRole(item) || item.type === 'plan') {
      sections.push({kind: 'message', item}); boundary = item.id; group = undefined;
    } else {
      if (!group) { group = {kind: 'execution', id: `${block.id}:after:${boundary}`, items: [], running: false}; sections.push(group); }
      group.items.push(item);
    }
  }
  if (block.state === 'running') {
    const last = sections.at(-1);
    if (last?.kind === 'execution') last.running = true;
    else if (!last || last.item.phase !== 'final_answer') sections.push({kind: 'execution', id: `${block.id}:after:${boundary}`, items: [], running: true});
  }
  return sections;
}

export function executionItemLabel(item: RemoteItem | undefined, running: boolean): string {
  if (!item) return '正在思考';
  if (item.subAgents?.length) {
    if (item.type === 'subAgentActivity') return `子 Agent · ${subAgentStatusLabel[item.subAgents[0]!.status]}`;
    const action: Record<string, string> = { spawnAgent: '创建子 Agent', wait: '等待子 Agent', closeAgent: '关闭子 Agent', resumeAgent: '恢复子 Agent', interruptAgent: '中断子 Agent', followupTask: '安排子 Agent 任务', sendInput: '向子 Agent 发送指令', sendMessage: '向子 Agent 发送消息', listAgents: '查看子 Agent' };
    return `${running && item.status === 'inProgress' ? '正在' : '已'}${action[item.tool ?? ''] || '协调子 Agent'}`;
  }
  const active = itemActive(item, running);
  if (item.type === 'reasoning') return active ? '正在思考' : '已思考';
  if (item.command || item.type === 'commandExecution') return active ? '正在运行命令' : '已运行命令';
  if (item.files?.length || item.type === 'fileChange') return active ? '正在修改文件' : '已修改文件';
  const action = toolAction(item);
  if (action) return `${active ? '正在' : '已'}${action}`;
  if (item.type === 'error') return '发生错误';
  return `${active ? '正在调用' : '已调用'}${item.tool || '工具'}`;
}

function oneLine(value: string | undefined) {
  return (value ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean)?.replace(/^#{1,6}\s+/, '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').slice(0, 220) ?? '';
}
/** Unwrap only recognized shell launchers for display. Keep the recorded command intact. */
export function displayCommand(command: string): string {
  const shell = command.trim().match(/^(?:"[^"\r\n]*[\\/]((?:pwsh|powershell|cmd|bash|zsh|sh)(?:\.exe)?)"|'[^'\r\n]*[\\/]((?:pwsh|powershell|cmd|bash|zsh|sh)(?:\.exe)?)'|((?:pwsh|powershell|cmd|bash|zsh|sh)(?:\.exe)?))\s+(.*)$/is);
  if (!shell) return command;
  const name = (shell[1] || shell[2] || shell[3] || '').toLowerCase();
  const flags = shell[4]!.match(name.startsWith('cmd') ? /^(?:(?:\/d|\/s)\s+)*\/c\s+([\s\S]+)$/i
    : /^(?:(?:-NoLogo|-NoProfile|-NonInteractive|-ExecutionPolicy\s+\w+|-l)\s+)*(?:-Command|-c|-lc)\s+([\s\S]+)$/i);
  if (!flags) return command;
  const body = flags[1]!;
  return (body[0] === '"' || body[0] === "'") && body.at(-1) === body[0] ? body.slice(1, -1) : body;
}
function fileNames(paths: string[]) {
  const names = [...new Set(paths)].map(path => path.split(/[\\/]/).at(-1) || path);
  return names.slice(0, 2).map(name => name.slice(0, 80)).join('、') + (names.length > 2 ? ` 等 ${names.length} 个文件` : '');
}
function fileOperations(item: RemoteItem) {
  return item.fileOperations?.length ? item.fileOperations : (item.files ?? []).map(path => ({ path, kind: 'unknown' as const }));
}
const fileVerb = { add: '创建', update: '编辑', delete: '删除', unknown: '修改' };
const unsuccessful = (item: RemoteItem) => ['failed', 'interrupted', 'cancelled', 'declined', 'inProgress'].includes(item.status ?? '');

/** Uses only public summaries and recorded operations, never private reasoning content. */
export function executionItemSummary(item: RemoteItem | undefined, running: boolean): string {
  if (!item) return '正在思考';
  if (item.type === 'reasoning') return oneLine(item.text) || executionItemLabel(item, running);
  const label = executionItemLabel(item, running);
  if (item.subAgents?.length) return `${label} · ${item.subAgents.map(subAgentName).slice(0, 2).join('、')}${item.subAgents.length > 2 ? ` 等 ${item.subAgents.length} 个` : ''}`;
  const active = label.startsWith('正在');
  const prefix = item.status === 'failed' ? '失败：' : item.status === 'declined' ? '已拒绝：'
    : ['interrupted', 'cancelled'].includes(item.status ?? '') ? '已停止：' : active ? '正在' : '已';
  const title = oneLine(item.activityTitle);
  if (title) return `${['失败：', '已拒绝：', '已停止：'].includes(prefix) ? prefix : ''}${title}`;
  if (item.command || item.type === 'commandExecution') return `${prefix}运行${item.command ? ` ${oneLine(item.commandPreview || displayCommand(item.command))}` : '命令'}`;
  if (item.files?.length || item.fileOperations?.length || item.type === 'fileChange') {
    const operations = fileOperations(item);
    const descriptions = (['add', 'update', 'delete', 'unknown'] as const).flatMap(kind => {
      const paths = operations.filter(operation => operation.kind === kind).map(operation => operation.path);
      return paths.length ? [`${fileVerb[kind]} ${fileNames(paths)}`] : [];
    });
    return `${prefix}${descriptions.join('，') || '修改文件'}`;
  }
  const action = toolAction(item);
  if (action) return `${prefix}${action}`;
  if (item.type === 'error') return item.text ? `发生错误：${oneLine(item.text)}` : '发生错误';
  return `${prefix}调用${item.tool || '工具'}${oneLine(item.text) ? ` · ${oneLine(item.text)}` : ''}`;
}

/** Empty reasoning placeholders have no public title; retain the latest named activity. */
export function executionSectionItem(section: ExecutionSection): RemoteItem | undefined {
  return [...section.items].reverse().find(item => item.type !== 'reasoning' || oneLine(item.text)) ?? section.items.at(-1);
}

/** Finished groups describe their work instead of always naming the final reasoning step. */
export function executionSectionSummary(section: ExecutionSection): string {
  const latest = executionSectionItem(section);
  if (section.running) return executionItemSummary(latest, true);
  const publicSummary = [...section.items].reverse().find(item => item.type === 'reasoning' && oneLine(item.text));
  if (publicSummary && !section.items.some(item => ['failed', 'interrupted', 'cancelled', 'declined'].includes(item.status ?? ''))) return executionItemSummary(publicSummary, false);
  const operations = section.items.filter(item => item.type !== 'reasoning' && !unsuccessful(item));
  const failure = section.items.find(item => ['failed', 'interrupted', 'cancelled', 'declined'].includes(item.status ?? ''));
  if (!operations.length) return executionItemSummary(failure ?? latest, false);
  if (operations.length === 1 && !failure) return executionItemSummary(operations[0], false);
  const files = operations.flatMap(fileOperations);
  const commands = operations.filter(item => item.command || item.type === 'commandExecution');
  const tools = operations.filter(item => !item.command && item.type !== 'commandExecution' && !item.files?.length && !item.fileOperations?.length && item.type !== 'fileChange');
  const descriptions = (['add', 'update', 'delete', 'unknown'] as const).flatMap(kind => {
    const paths = [...new Set(files.filter(operation => operation.kind === kind).map(operation => operation.path))];
    return paths.length ? [`${fileVerb[kind]}${kind === 'add' && paths.length === 1 ? ` ${fileNames(paths)}` : paths.length > 1 ? ` ${paths.length} 个文件` : '文件'}`] : [];
  });
  if (commands.length) descriptions.push(`运行${descriptions.length || commands.length === 1 ? '' : ` ${commands.length} 条`}命令`);
  if (tools.length) descriptions.push(tools.length === 1 ? `调用 ${tools[0]!.tool || '工具'}` : '调用工具');
  const result = descriptions.length > 1 ? `${descriptions.slice(0, -1).join('，')}并${descriptions.at(-1)}` : descriptions[0];
  return `已${result || '处理'}${failure ? '，部分操作未完成' : ''}`;
}

export function completedTurnBlocks(turn: HistoryTurn): ConversationBlock[] {
  return buildActivityBlocks(turn, false);
}

export function messageRole(item: RemoteItem): "user" | "assistant" | undefined {
  const type = item.type.toLowerCase();
  if (type === "usermessage" || type === "user" || type === "steeringusermessage") return "user";
  if (type === "agentmessage" || type === "assistantmessage" || type === "assistant") return "assistant";
  return undefined;
}

export function itemDuration(item: RemoteItem): number | undefined {
  if (item.durationMs !== undefined) return item.durationMs;
  if (item.startedAtMs !== undefined && item.completedAtMs !== undefined && item.completedAtMs >= item.startedAtMs) return item.completedAtMs - item.startedAtMs;
  return undefined;
}

export function formatDuration(durationMs: number): string {
  if (durationMs > 0 && durationMs < 1000) return "不到1秒";
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return `${hours ? `${hours}小时` : ""}${minutes ? `${minutes}分钟` : ""}${rest || !hours && !minutes ? `${rest}秒` : ""}`;
}

export function activityLabel(block: ActivityBlock, nowMs = Date.now()): string {
  const duration = block.state === "running" && block.startedAtMs !== undefined ? Math.max(0, nowMs - block.startedAtMs) : block.durationMs;
  const elapsed = duration === undefined ? "" : ` ${formatDuration(duration)}`;
  if (block.state === "running") return `正在处理${elapsed}`;
  if (block.state === "interrupted") return `已停止${duration === undefined ? "" : ` · 用时${elapsed}`}`;
  if (block.state === "failed") return `处理失败${elapsed}`;
  if (block.state === "recorded") return "处理记录";
  return duration === undefined ? "处理记录" : `已处理${elapsed}`;
}

export function buildActivityBlocks(turn: HistoryTurn, isActive: boolean): ConversationBlock[] {
  const first = turn.items[0];
  const initialUser = first && messageRole(first) === "user" && first.type.toLowerCase() !== "steeringusermessage" ? first : undefined;
  const process = initialUser ? turn.items.slice(1) : turn.items;
  const running = isActive && turn.status === "inProgress";
  const state = running ? "running" : turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "failed" : "recorded";
  const startedAtMs = turn.startedAtMs ?? initialUser?.completedAtMs ?? initialUser?.startedAtMs ?? turn.previousMessage?.completedAtMs ?? turn.previousMessage?.startedAtMs ?? process[0]?.startedAtMs;
  const durationMs = turn.durationMs ?? (startedAtMs !== undefined && turn.completedAtMs !== undefined && turn.completedAtMs >= startedAtMs ? turn.completedAtMs - startedAtMs : undefined);
  const activity: ActivityBlock = { kind: "activity", id: `${turn.id}:work`, items: process, state,
    ...(startedAtMs !== undefined ? { startedAtMs } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
  return [...(initialUser ? [{ kind: "message" as const, item: initialUser }] : []),
    ...(process.length || durationMs !== undefined || running ? [activity] : [])];
}

export function mergeLiveTurn(history: HistoryTurn, live: HistoryTurn, active = false): HistoryTurn {
  if (!active && history.status === "completed" && live.status !== "completed" && history.items.some(item => item.phase === "final_answer")) return { ...history, ...(live.tokenUsage ? { tokenUsage: live.tokenUsage } : {}) };
  const previous = new Map(history.items.map(item => [item.id, item]));
  const items = live.items.map(item => {
    const recorded = previous.get(item.id);
    if (recorded && messageRole(item) === "user" && item.truncated && (recorded.text?.length ?? 0) > (item.text?.length ?? 0)) return { ...item, ...recorded };
    // Completed history has larger text/output limits than a live snapshot.
    if (history.status === "completed" && live.status === "completed" && recorded && item.truncated) return { ...item, ...recorded };
    return { ...recorded, ...item };
  });
  const changes = new Map((history.fileChanges ?? []).map(change => [change.path, change]));
  for (const change of live.fileChanges ?? []) {
    const previous = changes.get(change.path);
    const delta = change.additions + change.deletions - (previous ? previous.additions + previous.deletions : 0);
    if (!previous || delta > 0 || delta === 0 && change.diff.length > previous.diff.length) changes.set(change.path, change);
  }
  const merged = { ...history, ...live, ...(changes.size ? { fileChanges: [...changes.values()] } : {}) };
  if (!live.itemsTruncatedBefore) return { ...merged, items, truncated: Boolean(live.itemsTruncatedAfter || items.some(item => item.truncated)) };
  // The desktop's current sequence is authoritative. A historical page may have
  // recorded a steering entry or streamed reply at its former position.
  const combined = [...items];
  const ids = new Set(combined.map(item => item.id));
  for (let index = 0; index < history.items.length; index++) {
    const item = history.items[index]!;
    if (ids.has(item.id)) continue;
    const next = history.items.slice(index + 1).find(candidate => ids.has(candidate.id));
    const previous = [...history.items.slice(0, index)].reverse().find(candidate => ids.has(candidate.id));
    const timed = item.startedAtMs === undefined ? -1 : combined.findIndex(candidate => candidate.startedAtMs !== undefined && candidate.startedAtMs > item.startedAtMs!);
    const position = timed >= 0 ? timed : next ? combined.findIndex(existing => existing.id === next.id) : previous ? combined.findIndex(existing => existing.id === previous.id) + 1 : 0;
    combined.splice(position, 0, item);
    ids.add(item.id);
  }
  return { ...merged, previousMessage: history.previousMessage ?? live.previousMessage, itemsTruncatedBefore: history.itemsTruncatedBefore ?? false, itemsTruncatedAfter: live.itemsTruncatedAfter ?? false,
    items: combined, truncated: Boolean(history.truncated || live.truncated || combined.some(item => item.truncated)) };
}

/** Both inputs are chronological. Insert missing turns beside their shared neighbours,
 * so an overlapping page or live preview cannot append an older turn at the bottom.
 */
export function mergeTurnHistory(recorded: HistoryTurn[], incoming: HistoryTurn[], placement: 'earlier' | 'latest' = 'latest', activeTurnId?: string | null): HistoryTurn[] {
  const turns = [...recorded];
  const updates = new Map(incoming.map(turn => [turn.id, turn]));
  for (let index = 0; index < turns.length; index++) {
    const update = updates.get(turns[index]!.id);
    if (update) turns[index] = mergeLiveTurn(turns[index]!, update, update.id === activeTurnId);
  }
  for (let index = 0; index < incoming.length; index++) {
    const turn = incoming[index]!;
    if (turns.some(existing => existing.id === turn.id)) continue;
    const next = incoming.slice(index + 1).find(candidate => turns.some(existing => existing.id === candidate.id));
    const previous = incoming.slice(0, index).reverse().find(candidate => turns.some(existing => existing.id === candidate.id));
    const position = next ? turns.findIndex(existing => existing.id === next.id)
      : previous ? turns.findIndex(existing => existing.id === previous.id) + 1
      : placement === 'earlier' ? 0 : turns.length;
    turns.splice(position, 0, turn);
  }
  return turns;
}
