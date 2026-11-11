import { themedStyles } from './theme';
import { useEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Archive, Bot, ChevronDown, Info, Menu, MoreHorizontal, Pencil, RefreshCw, Trash2 } from "lucide-react-native";
import type { RemoteSubAgent } from "../../../packages/protocol/src/index";
import {
  subAgentCounts,
  subAgentName,
  subAgentStatusLabel,
  subAgentUsageLabel,
  subAgentUsageTotal,
} from "../../../packages/client-shared/src/sub-agents";
import { ThreadNotificationToggle, useThreadNotification } from "./thread-notification";
import { useTheme } from "./styles";
import { ConversationId } from './conversation-id';
import { TaskStatusDot } from './task-status-dot';
import { MarqueeTitle } from './marquee-title';
import { ThreadUsage } from './project-usage';
import type { ThreadUsage as Usage } from '../../../packages/protocol/src/index';
import { InteractionSurface } from './interaction/surface';
import { ContextMenuGroup, ContextMenuRow } from './interaction/context-menu';
import { estimateProjectCost } from '../../../packages/client-shared/src/project-usage';

function AgentCard({ agent }: { agent: RemoteSubAgent }) {
  const { c, s } = useTheme();
  const hs = useHsStyles();
  const cost = agent.usage ? estimateProjectCost(agent.usage) : undefined;
  function statusColor(agent: RemoteSubAgent) {
    return agent.status === "errored" || agent.status === "notFound"
      ? c.danger
      : agent.status === "running" || agent.status === "pendingInit"
        ? c.accent
        : agent.status === "completed"
          ? c.success
          : c.muted;
  }

  const [expanded, setExpanded] = useState(false);
  return (
    <View style={hs.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${subAgentName(agent)}，${subAgentStatusLabel[agent.status]}，${expanded ? "收起" : "展开"}详情`}
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        style={hs.cardHead}
      >
        <View style={[hs.dot, { backgroundColor: statusColor(agent) }]} />
        <Text style={hs.agentName} numberOfLines={1}>
          {subAgentName(agent)}
        </Text>
        <Text style={[hs.status, { color: statusColor(agent) }]}>
          {subAgentStatusLabel[agent.status]}
        </Text>
        <ChevronDown size={14} color={c.muted} style={expanded ? s.rotated : undefined} />
      </Pressable>
      <Text selectable numberOfLines={expanded ? undefined : 3} style={hs.task}>
        {agent.task || "当前 Codex 记录未提供任务正文"}
      </Text>
      <Text style={hs.source}>{agent.statusSource === "thread" ? "会话状态" : "最近活动记录"}</Text>
      <Text selectable testID={`sub-agent-usage-${agent.threadId}`} style={hs.usage}>
        {subAgentUsageLabel(agent.usage)}
      </Text>
      {expanded && (
        <View style={hs.details}>
          {!!agent.usage && <>
            {agent.usage.models.map((model, index) => <Text key={`${model.model}:${index}`} selectable style={hs.source}>
              {model.model ?? '模型未知'} · 输入 {model.inputTokens.toLocaleString()} · 缓存命中 {model.cachedInputTokens.toLocaleString()} · 输出 {model.outputTokens.toLocaleString()}
            </Text>)}
            {!!cost?.unpricedTokens && <Text style={hs.source}>
              {cost.unpricedTokens.toLocaleString()} Token 缺少计价明细。
            </Text>}
          </>}
          {!!(agent.role || agent.model) && (
            <Text selectable style={hs.source}>
              {[agent.role, agent.model].filter(Boolean).join(" · ")}
            </Text>
          )}
          {!!agent.message && (
            <>
              <Text style={hs.resultLabel}>最近消息</Text>
              <Text selectable style={hs.task}>
                {agent.message}
              </Text>
            </>
          )}
          {!agent.message && <Text style={hs.source}>当前记录没有可读取的消息</Text>}
          {agent.truncated && <Text style={hs.source}>长任务或消息仅显示部分内容。</Text>}
        </View>
      )}
    </View>
  );
}

export function ConversationHeader({
  title,
  subtitle,
  threadUsage,
  running = false,
  deviceId,
  threadId,
  agents,
  supported,
  synchronized,
  truncated,
  hasTruncatedContent,
  onDrawer,
  onRefresh,
  onInfo,
  onRename,
  onArchive,
  onDelete,
  managementDisabled = false,
}: {
  title: string;
  subtitle: string;
  threadUsage?: Usage;
  running?: boolean;
  deviceId: string;
  threadId: string;
  agents: RemoteSubAgent[];
  supported: boolean;
  synchronized: boolean;
  truncated: boolean;
  hasTruncatedContent: boolean;
  onDrawer?: () => void;
  onRefresh: () => void;
  onInfo: () => void;
  onRename?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  managementDisabled?: boolean;
}) {
  const { c, s } = useTheme();
  const hs = useHsStyles();
  const [panel, setPanel] = useState<"options" | "agents" | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const host = useRef<View>(null), optionsAnchor = useRef<View>(null);
  const notification = useThreadNotification({ deviceId, threadId });
  const agentUsage = subAgentUsageTotal(agents, truncated);
  const counts = subAgentCounts(agents);
  const notifying = notification.notification?.allEnabled || notification.notification?.enabled;
  const active = counts.running + counts.pending;
  const badge = synchronized && active ? `${active}/${counts.total}` : `${counts.total}`;
  const color =
    synchronized && active ? c.accent : synchronized && counts.errors ? c.danger : c.muted;
  const agentLabel = `子 Agent，共 ${counts.total} 个${synchronized ? `，${counts.running} 个运行中，${counts.pending} 个等待启动` : "，状态待同步"}`;
  // Keep content mounted through the closing animation, as with the other menus.
  const openPanel = (kind: "options" | "agents") => {
    setPanel(kind);
    setPanelOpen(true);
  };
  const closePanel = () => setPanelOpen(false);
  // Open sibling dialogs only after this modal has released its focus trap.
  const afterClose = useRef<(() => void) | null>(null);
  const actionFrame = useRef(0);
  const choose = (action: () => void) => { afterClose.current = action; closePanel(); };

  useEffect(() => {
    setPanel(null);
    setPanelOpen(false);
    afterClose.current = null;
    return () => cancelAnimationFrame(actionFrame.current);
  }, [deviceId, threadId]);

  return (
    <>
      <View testID="conversation-header" style={[s.threadHeader, { height: undefined, minHeight: 76, paddingHorizontal: 4 }]}>
        {!!onDrawer && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="打开会话列表"
            onPress={onDrawer}
            style={s.iconButton}
          >
            <Menu size={20} color={c.text} />
          </Pressable>
        )}
        <View style={s.threadHeading}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 0 }}>
            {running && <TaskStatusDot running label="当前会话正在运行" />}
            <MarqueeTitle key={`${deviceId}:${threadId}`} text={title} />
          </View>
          <Text style={[s.sub, { fontSize: 11, lineHeight: 15 }]} numberOfLines={1}>
            {subtitle}
          </Text>
          {!!threadId && <ThreadUsage key={`${deviceId}:${threadId}`} usage={threadUsage} />}
        </View>
        {!!threadId && counts.total > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={agentLabel}
            onPress={() => openPanel("agents")}
            style={({ pressed }) => [
              hs.agentButton,
              active > 0 && synchronized && hs.agentActive,
              pressed && s.pressed,
            ]}
          >
            <Bot size={18} color={color} />
            <Text style={[hs.badge, { color }]}>{badge}</Text>
          </Pressable>
        )}
        <Pressable
          ref={optionsAnchor}
          collapsable={false}
          accessibilityRole="button"
          accessibilityLabel={`会话选项${notifying ? "，微信通知已开启" : ""}`}
          accessibilityState={{ expanded: panelOpen && panel === 'options', disabled: !threadId }}
          disabled={!threadId}
          onPress={() => openPanel("options")}
          style={({ pressed }) => [s.iconButton, pressed && s.pressed, !threadId && s.disabled]}
        >
          <MoreHorizontal size={21} color={c.text} style={{ opacity: panelOpen && panel === 'options' ? .15 : 1 }} />
          {notifying && <View style={[hs.notifyDot, panelOpen && panel === 'options' && { opacity: .15 }]} />}
        </Pressable>
      </View>
      <Modal
        transparent
        visible={panel !== null}
        animationType="none"
        onRequestClose={closePanel}
      >
        <View ref={host} collapsable={false} style={{ flex: 1 }}>
          <InteractionSurface open={panelOpen} onClose={closePanel} onClosed={() => {
            setPanel(null);
            const action = afterClose.current; afterClose.current = null;
            if (action) actionFrame.current = requestAnimationFrame(action);
          }} host={host} anchor={panel === 'options' ? optionsAnchor : undefined} align="end" width={252}
            kind={panel === 'options' ? 'popover' : 'sheet'} variant={panel === 'options' ? 'menu' : 'default'}
            title={panel === 'options' ? '会话菜单' : '子 Agent'}>
            <ScrollView style={hs.scroll} contentContainerStyle={panel === 'options' ? undefined : hs.content} keyboardShouldPersistTaps="handled">
              {panel === 'options' ? <View testID="conversation-options-menu" style={{ borderRadius: 14, overflow: 'hidden' }}>
                <Text numberOfLines={1} style={hs.menuTitle}>{title}</Text>
                <ContextMenuGroup>
                  {!!onRename && <ContextMenuRow title="重命名" Icon={Pencil} disabled={managementDisabled} onPress={() => choose(onRename)} />}
                  <ConversationId key={`${deviceId}:${threadId}:${panelOpen}`} threadId={threadId} variant="menu" />
                  {!!onArchive && <ContextMenuRow title="归档" Icon={Archive} danger disabled={managementDisabled} onPress={() => choose(onArchive)} />}
                  {!!onDelete && <ContextMenuRow title="删除会话" Icon={Trash2} danger disabled={managementDisabled} onPress={() => choose(onDelete)} />}
                </ContextMenuGroup>
                <View style={hs.menuDivider} />
                <ContextMenuGroup>
                  <ContextMenuRow title="刷新会话" Icon={RefreshCw} onPress={() => choose(onRefresh)} />
                </ContextMenuGroup>
                {notification.visible && <><View style={hs.menuDivider} /><ThreadNotificationToggle control={notification} variant="menu" /></>}
              </View> : (
                <>
                  <Text style={hs.summary}>
                    {synchronized
                      ? `共 ${counts.total} 个 · ${counts.running} 个运行中${counts.pending ? ` · ${counts.pending} 个等待启动` : ""}`
                      : "连接恢复后更新状态，以下为最后同步记录"}
                  </Text>
                  {!!agents.length && <View testID="sub-agents-usage-total" style={hs.usageTotal}>
                    <Text selectable style={hs.usage}>{subAgentUsageLabel(agentUsage.usage, '子 Agent 合计')}</Text>
                    <Text style={hs.source}>仅合计这些子 Agent 的独立会话，不含主会话 · {agentUsage.known}/{agentUsage.total} 个有累计计数</Text>
                  </View>}
                  {agents.map((agent) => (
                    <AgentCard key={agent.threadId} agent={agent} />
                  ))}
                  {!agents.length && (
                    <Text style={hs.empty}>
                      {!supported
                        ? "当前 PC 连接器尚未同步子 Agent 数据，请更新连接器。"
                        : synchronized
                          ? "这个会话暂未发现子 Agent。"
                          : "等待 PC 同步子 Agent 状态。"}
                    </Text>
                  )}
                  {truncated && (
                    <Text style={hs.source}>部分较早的 Agent 或长内容未完整显示。</Text>
                  )}
                  {!!agents.length && (
                    <Text style={hs.footnote}>
                      状态与用量随 PC 同步更新；费用按各模型 API 单价估算。缺少用量时显示待同步，部分记录显示已知下限。
                    </Text>
                  )}
                </>
              )}
            </ScrollView>
          </InteractionSurface>
        </View>
      </Modal>
    </>
  );
}

const useHsStyles = themedStyles(c => StyleSheet.create({
  agentButton: {
    minHeight: 36,
    minWidth: 52,
    paddingHorizontal: 9,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  agentActive: { backgroundColor: c.soft },
  badge: { fontSize: 12, fontWeight: "600" },
  notifyDot: {
    position: "absolute",
    right: 8,
    top: 8,
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: c.success,
  },
  menuTitle: { fontSize: 11, lineHeight: 16, color: c.muted, paddingHorizontal: 15, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line },
  menuDivider: { height: 5, backgroundColor: c.line },
  scroll: { flexShrink: 1 },
  content: { padding: 20, paddingTop: 8, gap: 10 },
  summary: { fontSize: 12, color: c.muted, lineHeight: 19, paddingVertical: 6 },
  card: { borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 12, gap: 7 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 28 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  agentName: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: "600", color: c.text },
  status: { fontSize: 12 },
  task: { fontSize: 13, lineHeight: 20, color: c.text },
  source: { fontSize: 11, lineHeight: 17, color: c.muted },
  usage: { fontSize: 12, lineHeight: 19, color: c.text },
  usageTotal: { borderRadius: 10, backgroundColor: c.soft, padding: 12, gap: 4 },
  details: { borderTopWidth: 1, borderTopColor: c.line, paddingTop: 8, gap: 6 },
  resultLabel: { fontSize: 12, color: c.muted },
  empty: { fontSize: 14, color: c.muted, lineHeight: 22, paddingVertical: 25, textAlign: "center" },
  footnote: { fontSize: 11, lineHeight: 17, color: c.muted, paddingVertical: 6 },
}));
