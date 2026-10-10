import { useEffect, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Bot, ChevronDown, Info, Menu, MoreHorizontal, RefreshCw, X } from "lucide-react-native";
import type { RemoteSubAgent } from "../../../packages/protocol/src/index";
import {
  subAgentCounts,
  subAgentName,
  subAgentStatusLabel,
} from "../../../packages/client-shared/src/sub-agents";
import { ThreadNotificationToggle, useThreadNotification } from "./thread-notification";
import { c, s } from "./styles";

function statusColor(agent: RemoteSubAgent) {
  return agent.status === "errored" || agent.status === "notFound"
    ? c.danger
    : agent.status === "running" || agent.status === "pendingInit"
      ? c.accent
      : agent.status === "completed"
        ? "#248353"
        : c.muted;
}

function AgentCard({ agent }: { agent: RemoteSubAgent }) {
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
      {expanded && (
        <View style={hs.details}>
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
}: {
  title: string;
  subtitle: string;
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
}) {
  const [panel, setPanel] = useState<"options" | "agents" | null>(null);
  const [panelContent, setPanelContent] = useState<"options" | "agents">("options");
  const { width, height } = useWindowDimensions();
  const notification = useThreadNotification({ deviceId, threadId });
  const counts = subAgentCounts(agents);
  const notifying = notification.notification?.allEnabled || notification.notification?.enabled;
  const active = counts.running + counts.pending;
  const badge = synchronized && active ? `${active}/${counts.total}` : `${counts.total}`;
  const color =
    synchronized && active ? c.accent : synchronized && counts.errors ? c.danger : c.muted;
  const agentLabel = `子 Agent，共 ${counts.total} 个${synchronized ? `，${counts.running} 个运行中，${counts.pending} 个等待启动` : "，状态待同步"}`;
  // Keep content mounted through the closing animation, as with the other menus.
  const openPanel = (kind: "options" | "agents") => {
    setPanelContent(kind);
    setPanel(kind);
  };

  useEffect(() => {
    setPanel(null);
  }, [deviceId, threadId]);
  useEffect(() => {
    if (!panel || Platform.OS !== "web") return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setPanel(null);
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [panel]);

  return (
    <>
      <View testID="conversation-header" style={s.threadHeader}>
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
          <Text testID="conversation-title" style={s.threadTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={s.sub} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        {!!threadId && (
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
          accessibilityRole="button"
          accessibilityLabel={`会话选项${notifying ? "，微信通知已开启" : ""}`}
          disabled={!threadId}
          onPress={() => openPanel("options")}
          style={({ pressed }) => [s.iconButton, pressed && s.pressed, !threadId && s.disabled]}
        >
          <MoreHorizontal size={21} color={c.text} />
          {notifying && <View style={hs.notifyDot} />}
        </Pressable>
      </View>
      <Modal
        transparent
        visible={panel !== null}
        animationType="fade"
        onRequestClose={() => setPanel(null)}
      >
        <View style={hs.overlay}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭会话面板"
            style={StyleSheet.absoluteFill}
            onPress={() => setPanel(null)}
          />
          <View style={[hs.dialog, { width: Math.min(width - 32, 520), maxHeight: height * 0.82 }]}>
            <View style={hs.dialogHead}>
              <Text accessibilityRole="header" style={hs.dialogTitle}>
                {panelContent === "agents" ? "子 Agent" : "会话选项"}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭"
                style={s.iconButton}
                onPress={() => setPanel(null)}
              >
                <X size={19} color={c.text} />
              </Pressable>
            </View>
            <ScrollView style={hs.scroll} contentContainerStyle={hs.content}>
              {panelContent === "options" ? (
                <>
                  <ThreadNotificationToggle control={notification} />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="查看子 Agent"
                    onPress={() => openPanel("agents")}
                    style={hs.option}
                  >
                    <Bot size={18} color={c.muted} />
                    <Text style={hs.optionText}>子 Agent</Text>
                    <Text style={hs.source}>{counts.total} 个</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="刷新会话"
                    onPress={() => {
                      setPanel(null);
                      onRefresh();
                    }}
                    style={hs.option}
                  >
                    <RefreshCw size={18} color={c.muted} />
                    <Text style={hs.optionText}>刷新会话</Text>
                  </Pressable>
                  {hasTruncatedContent && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="查看会话展示范围"
                      onPress={() => {
                        setPanel(null);
                        onInfo();
                      }}
                      style={hs.option}
                    >
                      <Info size={18} color={c.muted} />
                      <Text style={hs.optionText}>会话展示范围</Text>
                    </Pressable>
                  )}
                </>
              ) : (
                <>
                  <Text style={hs.summary}>
                    {synchronized
                      ? `共 ${counts.total} 个 · ${counts.running} 个运行中${counts.pending ? ` · ${counts.pending} 个等待启动` : ""}`
                      : "连接恢复后更新状态，以下为最后同步记录"}
                  </Text>
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
                      状态随 PC 同步更新；「最近活动记录」表示最近已知状态。
                    </Text>
                  )}
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const hs = StyleSheet.create({
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
    backgroundColor: "#248353",
  },
  overlay: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0005" },
  dialog: { backgroundColor: c.surface, borderRadius: 16, overflow: "hidden" },
  dialogHead: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 20,
    paddingRight: 8,
    paddingTop: 8,
    borderBottomWidth: 1,
    borderBottomColor: c.line,
  },
  dialogTitle: { flex: 1, fontSize: 17, fontWeight: "600", color: c.text },
  scroll: { flexShrink: 1 },
  content: { padding: 20, paddingTop: 8, gap: 10 },
  option: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 9,
  },
  optionText: { flex: 1, fontSize: 14, color: c.text },
  summary: { fontSize: 12, color: c.muted, lineHeight: 19, paddingVertical: 6 },
  card: { borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 12, gap: 7 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 28 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  agentName: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: "600", color: c.text },
  status: { fontSize: 12 },
  task: { fontSize: 13, lineHeight: 20, color: c.text },
  source: { fontSize: 11, lineHeight: 17, color: c.muted },
  details: { borderTopWidth: 1, borderTopColor: c.line, paddingTop: 8, gap: 6 },
  resultLabel: { fontSize: 12, color: c.muted },
  empty: { fontSize: 14, color: c.muted, lineHeight: 22, paddingVertical: 25, textAlign: "center" },
  footnote: { fontSize: 11, lineHeight: 17, color: c.muted, paddingVertical: 6 },
});
