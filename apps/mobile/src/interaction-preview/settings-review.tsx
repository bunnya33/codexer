import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  ArrowLeft,
  Bell,
  Check,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  Info,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Search,
  Settings2,
  Sun,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { ChromeButton } from "../interaction/primitives";
import { useTheme } from "../styles";
import { previewAccents } from "./review-fixtures";
import type { PreviewPreferences, ReviewCondition } from "./review-fixtures";

export type SettingsReviewSection =
  "overview" | "appearance" | "accent" | "connection" | "updates" | "about";
const appearanceLabels = { system: "跟随系统", light: "浅色", dark: "深色" };
const sections = [
  { id: "appearance", name: "外观", group: "主题", Icon: Sun },
  { id: "accent", name: "强调色", group: "主题", Icon: Palette },
  { id: "connection", name: "服务器与设备", group: "连接", Icon: Monitor },
  { id: "updates", name: "更新与下载", group: "应用", Icon: Download },
  { id: "about", name: "关于与版本", group: "应用", Icon: Info },
] as const;
export function SettingsReviewPanel({
  section,
  onSection,
  preferences,
  onPreferences,
  condition,
  onCopy,
  onNotice,
}: {
  section: SettingsReviewSection;
  onSection: (section: SettingsReviewSection) => void;
  preferences: PreviewPreferences;
  onPreferences: (value: PreviewPreferences) => void;
  condition: ReviewCondition;
  onCopy: (text: string) => void;
  onNotice: (text: string) => void;
}) {
  const { c } = useTheme();
  const [query, setQuery] = useState(""),
    [confirmRefresh, setConfirmRefresh] = useState(false);
  const selected = sections.find((entry) => entry.id === section);
  const title = (text: string) => (
    <Text style={{ color: c.muted, fontSize: 11, marginTop: 22, marginBottom: 8, marginLeft: 13 }}>
      {text}
    </Text>
  );
  const row = (
    label: string,
    value?: string,
    onPress?: () => void,
    Icon?: LucideIcon,
    checked = false,
    last = false,
  ) => {
    const body = (
      <>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flex: 1 }}>
          {Icon && <Icon size={18} color={c.text} />}
          <Text style={{ color: c.text, fontSize: 14, flexShrink: 1 }}>{label}</Text>
        </View>
        {value && (
          <Text
            style={{
              color: c.muted,
              fontSize: 12,
              flexShrink: 1,
              textAlign: "right",
              maxWidth: "48%",
            }}
          >
            {value}
          </Text>
        )}
        {checked ? (
          <Check size={17} color={c.text} />
        ) : (
          onPress && <ChevronRight size={15} color={c.faint} />
        )}
      </>
    );
    const style = [
      s.row,
      { borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderBottomColor: c.line },
    ];
    return onPress ? (
      <Pressable
        key={label}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: checked }}
        onPress={onPress}
        style={style}
      >
        {body}
      </Pressable>
    ) : (
      <View key={label} style={style}>
        {body}
      </View>
    );
  };
  return (
    <View style={{ flex: 1, backgroundColor: c.sidebar, borderRadius: 17 }}>
      {section !== "overview" && (
        <View style={{ flexDirection: "row", alignItems: "center", paddingRight: 44 }}>
          <ChromeButton
            Icon={ArrowLeft}
            label="返回设置"
            onPress={() => {
              setConfirmRefresh(false);
              onSection("overview");
            }}
            size={19}
          />
          <Text
            style={{ flex: 1, color: c.text, fontSize: 16, fontWeight: "600", textAlign: "center" }}
          >
            {selected?.name}
          </Text>
        </View>
      )}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 28 }}
      >
        {section === "overview" ? (
          <>
            <View style={{ alignItems: "center", gap: 9, paddingVertical: 18 }}>
              <View style={[s.avatar, { backgroundColor: c.soft }]}>
                <Text style={{ color: c.accent, fontSize: 24, fontWeight: "700" }}>C</Text>
              </View>
              <Text style={{ color: c.text, fontSize: 17, fontWeight: "600" }}>
                Codexer Control
              </Text>
              <Text style={{ color: c.faint, fontSize: 11 }}>你的设备，你的工作空间</Text>
            </View>
            <View style={[s.search, { backgroundColor: c.composer }]}>
              <Search size={15} color={c.muted} />
              <TextInput
                accessibilityLabel="搜索设置"
                value={query}
                onChangeText={setQuery}
                placeholder="搜索设置"
                placeholderTextColor={c.faint}
                style={{ flex: 1, height: 40, color: c.text, fontSize: 13 }}
              />
            </View>
            {["应用设置", "主题", "连接", "应用"].map((group) => {
              const entries = sections.filter(
                (entry) => entry.group === group && entry.name.includes(query),
              );
              return entries.length ? (
                <View key={group}>
                  {title(group)}
                  <View style={[s.group, { backgroundColor: c.composer }]}>
                    {entries.map((entry, index) =>
                      row(
                        entry.name,
                        entry.id === "appearance"
                          ? appearanceLabels[preferences.appearance]
                          : entry.id === "accent"
                            ? previewAccents[preferences.accent].name
                            : undefined,
                        () => onSection(entry.id),
                        entry.Icon,
                        false,
                        index === entries.length - 1,
                      ),
                    )}
                  </View>
                </View>
              ) : null;
            })}
            {!sections.some((entry) => entry.name.includes(query)) && (
              <Text style={{ color: c.muted, textAlign: "center", padding: 25 }}>
                没有匹配的设置
              </Text>
            )}
          </>
        ) : section === "appearance" ? (
          <>
            {title("外观")}
            <View style={[s.group, { backgroundColor: c.composer }]}>
              {(["system", "light", "dark"] as const).map((appearance, index) =>
                row(
                  appearanceLabels[appearance],
                  undefined,
                  () => onPreferences({ ...preferences, appearance }),
                  appearance === "dark" ? Moon : appearance === "light" ? Sun : Monitor,
                  preferences.appearance === appearance,
                  index === 2,
                ),
              )}
            </View>
            <Text style={[s.note, { color: c.muted }]}>
              跟随系统时，界面会随设备的浅色或深色设置变化。
            </Text>
            <View style={{ flexDirection: "row", gap: 12, paddingVertical: 15 }}>
              {["#ffffff", "#111113"].map((background, index) => (
                <Pressable
                  key={background}
                  accessibilityRole="button"
                  accessibilityLabel={index ? "预览深色外观" : "预览浅色外观"}
                  onPress={() =>
                    onPreferences({ ...preferences, appearance: index ? "dark" : "light" })
                  }
                  style={{
                    flex: 1,
                    height: 156,
                    borderRadius: 18,
                    padding: 13,
                    borderWidth: 1,
                    borderColor: c.line,
                    backgroundColor: background,
                  }}
                >
                  <View
                    style={{
                      width: "65%",
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: index ? "#55555e" : "#d8d8df",
                      marginVertical: 13,
                    }}
                  />
                  <View
                    style={{
                      width: "77%",
                      alignSelf: "flex-end",
                      height: 33,
                      borderRadius: 12,
                      backgroundColor: index ? "#292b33" : "#eef1f9",
                      marginBottom: 16,
                    }}
                  />
                  <View
                    style={{
                      width: "90%",
                      height: 5,
                      borderRadius: 3,
                      backgroundColor: index ? "#424249" : "#e1e1e7",
                    }}
                  />
                  <View
                    style={{
                      width: "65%",
                      height: 5,
                      borderRadius: 3,
                      backgroundColor: index ? "#424249" : "#e1e1e7",
                      marginTop: 7,
                    }}
                  />
                  <View
                    style={{
                      height: 20,
                      borderRadius: 12,
                      marginTop: 17,
                      backgroundColor: index ? "#2a2a2e" : "#f2f2f5",
                    }}
                  />
                </Pressable>
              ))}
            </View>
          </>
        ) : section === "accent" ? (
          <>
            {title("强调色")}
            <View style={[s.group, { backgroundColor: c.composer }]}>
              {Object.entries(previewAccents).map(([key, value], index) => (
                <Pressable
                  key={key}
                  accessibilityRole="radio"
                  accessibilityLabel={`强调色：${value.name}`}
                  aria-checked={preferences.accent === key}
                  accessibilityState={{ checked: preferences.accent === key }}
                  onPress={() =>
                    onPreferences({ ...preferences, accent: key as PreviewPreferences["accent"] })
                  }
                  style={[
                    s.row,
                    {
                      borderBottomColor: c.line,
                      borderBottomWidth: index === 4 ? 0 : StyleSheet.hairlineWidth,
                    },
                  ]}
                >
                  <View
                    style={{
                      width: 19,
                      height: 19,
                      borderRadius: 10,
                      backgroundColor: value.color,
                    }}
                  />
                  <Text style={{ flex: 1, color: c.text, fontSize: 14 }}>{value.name}</Text>
                  {preferences.accent === key && <Check size={18} color={c.text} />}
                </Pressable>
              ))}
            </View>
            <Text style={[s.note, { color: c.muted }]}>
              强调色用于选中项和主要操作。任务运行、完成和错误仍保留各自的状态颜色。
            </Text>
          </>
        ) : section === "connection" ? (
          <>
            {title("当前连接")}
            <View style={[s.group, { backgroundColor: c.composer }]}>
              {row("服务器", "示例服务器", undefined, Monitor)}
              {row(
                "PC 工作站",
                condition === "offline" ? "离线" : "已连接",
                undefined,
                undefined,
                false,
                true,
              )}
            </View>
            {title("Codex 运行时")}
            <View style={[s.group, { backgroundColor: c.composer }]}>
              {row("刷新运行时", undefined, () => setConfirmRefresh(true), RefreshCw, false, true)}
            </View>
            {confirmRefresh && (
              <View
                style={{
                  padding: 15,
                  marginTop: 12,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: c.line,
                }}
              >
                <Text style={{ color: c.text, fontSize: 14, fontWeight: "600" }}>
                  刷新 Codex 运行时？
                </Text>
                <Text style={[s.note, { color: c.muted, paddingHorizontal: 0 }]}>
                  重新发现本机 Codex
                  并同步会话，期间连接可能暂时中断。正在执行的任务不应被当作已完成。
                </Text>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "flex-end",
                    gap: 18,
                    paddingTop: 12,
                  }}
                >
                  <Pressable accessibilityRole="button" onPress={() => setConfirmRefresh(false)}>
                    <Text style={{ color: c.muted }}>取消</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="确认演示运行时刷新"
                    onPress={() => {
                      setConfirmRefresh(false);
                      onNotice("已演示刷新确认流程，未操作真实设备");
                    }}
                  >
                    <Text style={{ color: c.accent }}>确认刷新</Text>
                  </Pressable>
                </View>
              </View>
            )}
            <Text style={[s.note, { color: c.muted }]}>
              此页为示例连接。正式版显示所选设备的真实状态和可用操作。
            </Text>
          </>
        ) : section === "updates" ? (
          <>
            {title("版本与下载")}
            <View style={[s.group, { backgroundColor: c.composer }]}>
              {row("Control", "网页交互稿 03")}
              {row("Agent", "示例设备")}
              {row(
                "检查更新",
                undefined,
                () => onNotice("交互稿不检查线上更新，正式版沿用现有更新服务"),
                Download,
                false,
                true,
              )}
            </View>
            <Text style={[s.note, { color: c.muted }]}>
              客户端、Agent 与服务器分别显示真实版本；仅有网页样稿不代表原生安装包已更新。
            </Text>
          </>
        ) : (
          <>
            {title("Codexer")}
            <View style={[s.group, { backgroundColor: c.composer }]}>
              {row("当前界面", "完整功能交互稿 03", undefined, Info)}
              {row(
                "复制诊断",
                undefined,
                () =>
                  onCopy(
                    "Codexer 交互样稿 03\n环境：本地网页样稿\n连接：示例设备，未接入实际服务器\n范围：问答、计划、文件/目录搜索、设置",
                  ),
                Copy,
                false,
                true,
              )}
            </View>
            {title("帮助")}
            <View style={[s.group, { backgroundColor: c.composer }]}>
              {row(
                "样稿说明",
                undefined,
                () => onNotice("所有会话、文件、费用和连接均为示例数据"),
                CircleHelp,
                false,
                true,
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
const s = StyleSheet.create({
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  group: { borderRadius: 15, paddingHorizontal: 13 },
  row: { minHeight: 53, flexDirection: "row", alignItems: "center", gap: 10 },
  note: { fontSize: 12, lineHeight: 20, paddingHorizontal: 12, marginTop: 12 },
});
