import type { ReactNode } from "react";
import type { ModalProps } from "react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  Info,
  MessageCircle,
  Monitor,
  Palette,
  Search,
  Settings2,
  X,
} from "lucide-react-native";
import { useTheme } from "./styles";

export type SettingsSection =
  "overview" | "general" | "appearance" | "connection" | "updates" | "about";
const entries = [
  { id: "general", label: "常规", group: "应用设置", Icon: Settings2 },
  { id: "appearance", label: "外观", group: "应用设置", Icon: Palette },
  { id: "connection", label: "服务器与设备", group: "连接", Icon: Monitor },
  { id: "weixin", label: "微信 ClawBot", group: "连接", Icon: MessageCircle },
  { id: "updates", label: "更新与下载", group: "应用", Icon: Download },
  { id: "about", label: "关于与版本", group: "应用", Icon: Info },
] as const;
// Desktop settings fill the existing native window. Other dialogs may still
// use a separate, size-constrained native modal window.
function DesktopSettingsFrame({ visible, children }: ModalProps) {
  return visible ? (
    <View style={[StyleSheet.absoluteFill, { zIndex: 1000 }]}>{children}</View>
  ) : null;
}
const SettingsFrame =
  Platform.OS === "windows" || Platform.OS === "macos" ? DesktopSettingsFrame : Modal;
export function SettingsShell({
  open,
  onClose,
  onWeixin,
  updateAvailable = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onWeixin: () => void;
  updateAvailable?: boolean;
  children: (section: SettingsSection) => ReactNode;
}) {
  const { c } = useTheme(),
    { width, height } = useWindowDimensions(),
    insets = useSafeAreaInsets(),
    wide = width >= 900;
  const [section, setSection] = useState<SettingsSection>("overview"),
    [query, setQuery] = useState(""),
    [present, setPresent] = useState(open);
  const translation = useRef(new Animated.Value(0)).current,
    closing = useRef(false);
  const sheetHeight = Math.max(160, height - insets.top - 12);
  useEffect(() => {
    if (open) {
      closing.current = false;
      setPresent(true);
      translation.setValue(wide ? 0 : sheetHeight);
      Animated.spring(translation, {
        toValue: 0,
        damping: 28,
        stiffness: 260,
        mass: 1,
        useNativeDriver: Platform.OS !== "web",
      }).start();
    } else setPresent(false);
    return () => translation.stopAnimation();
  }, [open, wide]);
  useEffect(() => {
    if (open) {
      setSection("overview");
      setQuery("");
    }
  }, [open]);
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    if (wide) {
      onClose();
      return;
    }
    Animated.timing(translation, {
      toValue: sheetHeight,
      duration: 180,
      useNativeDriver: Platform.OS !== "web",
    }).start(({ finished }) => {
      if (finished) onClose();
    });
  };
  const gestures = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, value) =>
          !wide && Math.abs(value.dy) > 8 && Math.abs(value.dy) > Math.abs(value.dx),
        onPanResponderMove: (_event, value) => translation.setValue(Math.max(0, value.dy)),
        onPanResponderRelease: (_event, value) => {
          if (value.dy > 110 || value.vy > 1) close();
          else
            Animated.spring(translation, {
              toValue: 0,
              useNativeDriver: Platform.OS !== "web",
            }).start();
        },
        onPanResponderTerminate: () =>
          Animated.spring(translation, {
            toValue: 0,
            useNativeDriver: Platform.OS !== "web",
          }).start(),
      }),
    [wide, sheetHeight, onClose],
  );
  const selected = section === "overview" ? (wide ? "general" : section) : section;
  const navigate = (id: (typeof entries)[number]["id"]) => {
    if (id === "weixin") onWeixin();
    else setSection(id);
  };
  const row = (entry: (typeof entries)[number], last: boolean) => {
    const Icon = entry.Icon,
      active = selected === entry.id;
    return (
      <Pressable
        key={entry.id}
        accessibilityRole="button"
        accessibilityLabel={entry.label}
        accessibilityState={{ selected: wide && active }}
        onPress={() => navigate(entry.id)}
        style={{
          minHeight: wide ? 44 : 57,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 14,
          borderRadius: wide ? 10 : 0,
          backgroundColor: wide && active ? c.soft : undefined,
          borderBottomWidth: !wide && !last ? StyleSheet.hairlineWidth : 0,
          borderBottomColor: c.settingsLine,
        }}
      >
        <Icon size={19} color={c.text} />
        <Text style={{ flex: 1, color: c.text, fontSize: 14 }}>{entry.label}</Text>
        {entry.id === "updates" && updateAvailable && (
          <View
            accessibilityLabel="控制端有新版本"
            style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#eb373a" }}
          />
        )}
        {!wide && <ChevronRight size={17} color={c.muted} />}
      </Pressable>
    );
  };
  return (
    <SettingsFrame
      visible={present}
      transparent
      animationType={wide ? "fade" : "none"}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={close}
    >
      <View style={{ flex: 1, backgroundColor: c.overlay, justifyContent: "flex-end" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭设置面板"
          onPress={close}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View
          testID="settings-shell"
          accessibilityViewIsModal
          accessibilityLabel="设置"
          style={{
            height: wide ? "100%" : sheetHeight,
            width: "100%",
            backgroundColor: wide ? c.bg : c.settingsGroup,
            borderTopLeftRadius: wide ? 0 : 26,
            borderTopRightRadius: wide ? 0 : 26,
            overflow: "hidden",
            flexDirection: wide ? "row" : "column",
            transform: [{ translateY: translation }],
          }}
        >
          {wide && (
            <View
              style={{
                width: 260,
                backgroundColor: c.sidebar,
                borderRightWidth: StyleSheet.hairlineWidth,
                borderColor: c.line,
                paddingHorizontal: 14,
                paddingTop: Math.max(insets.top, 24),
                paddingBottom: 20,
              }}
            >
              <Text style={{ fontSize: 20, fontWeight: "600", color: c.text, padding: 10 }}>
                设置
              </Text>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  backgroundColor: c.soft,
                  borderRadius: 20,
                  paddingHorizontal: 12,
                  marginVertical: 14,
                }}
              >
                <Search size={16} color={c.muted} />
                <TextInput
                  accessibilityLabel="搜索设置"
                  value={query}
                  onChangeText={setQuery}
                  placeholder="搜索设置"
                  placeholderTextColor={c.muted}
                  style={{ flex: 1, height: 38, color: c.text }}
                />
              </View>
              <ScrollView>
                {entries
                  .filter((entry) => entry.label.toLowerCase().includes(query.toLowerCase()))
                  .map((entry) => row(entry, true))}
              </ScrollView>
            </View>
          )}
          <View style={{ flex: 1, minHeight: 0 }}>
            <View
              {...(!wide ? gestures.panHandlers : {})}
              style={{
                paddingTop: wide ? Math.max(insets.top, 12) : 8,
                paddingHorizontal: wide ? 24 : 16,
                paddingBottom: 10,
                flexShrink: 0,
              }}
            >
              {!wide && (
                <View
                  style={{
                    height: 4,
                    width: 36,
                    borderRadius: 2,
                    backgroundColor: c.settingsLine,
                    alignSelf: "center",
                    marginBottom: 10,
                  }}
                />
              )}
              <View style={{ height: 42, flexDirection: "row", alignItems: "center", gap: 10 }}>
                {!wide && selected !== "overview" && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="返回设置"
                    onPress={() => setSection("overview")}
                    style={{ padding: 8 }}
                  >
                    <ArrowLeft size={21} color={c.text} />
                  </Pressable>
                )}
                <Text
                  style={{ flex: 1, fontSize: wide ? 22 : 18, fontWeight: "600", color: c.text }}
                >
                  {wide
                    ? ""
                    : selected === "overview"
                      ? "设置"
                      : entries.find((entry) => entry.id === selected)?.label}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="关闭设置"
                  onPress={close}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    backgroundColor: c.soft,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <X size={19} color={c.muted} />
                </Pressable>
              </View>
            </View>
            <ScrollView
              key={selected}
              testID="settings-content"
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{
                paddingHorizontal: wide ? 40 : 18,
                paddingTop: wide ? 32 : 10,
                paddingBottom: Math.max(insets.bottom, 20) + 20,
                alignItems: wide ? "center" : undefined,
              }}
              style={{ flex: 1 }}
            >
              <View style={{ width: "100%", maxWidth: wide ? 800 : undefined, gap: 22 }}>
                {!wide && selected === "overview" ? (
                  <>
                    {["应用设置", "连接", "应用"].map((group) => {
                      const items = entries.filter((entry) => entry.group === group);
                      return (
                        <View key={group} style={{ gap: 9 }}>
                          <Text style={{ color: c.muted, fontSize: 12, paddingLeft: 14 }}>
                            {group}
                          </Text>
                          <View
                            style={{
                              backgroundColor: c.surface,
                              borderRadius: 17,
                              overflow: "hidden",
                            }}
                          >
                            {items.map((entry, index) => row(entry, index === items.length - 1))}
                          </View>
                        </View>
                      );
                    })}
                    {children("overview")}
                  </>
                ) : (
                  <>
                    {wide && (
                      <Text
                        style={{ fontSize: 24, fontWeight: "600", color: c.text, marginBottom: 4 }}
                      >
                        {entries.find((entry) => entry.id === selected)?.label}
                      </Text>
                    )}
                    {children(selected)}
                  </>
                )}
              </View>
            </ScrollView>
          </View>
        </Animated.View>
      </View>
    </SettingsFrame>
  );
}
