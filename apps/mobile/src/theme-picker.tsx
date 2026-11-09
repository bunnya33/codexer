import { Pressable, StyleSheet, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { controlThemes } from "../../../packages/client-shared/src/themes";
import { useTheme } from "./styles";
import {
  accentNames,
  appearanceForSkin,
  resolveAppearance,
} from "../../../packages/client-shared/src/appearance";
import type { AppearancePreferences } from "../../../packages/client-shared/src/appearance";

export function ThemePicker() {
  const { theme, selectTheme, preferences, setPreferences, persistenceError, c } = useTheme();
  return (
    <View style={styles.section}>
      <Text style={{ fontSize: 12, color: c.muted }}>外观</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="外观模式"
        style={{ borderRadius: 16, overflow: "hidden", backgroundColor: c.composer }}
      >
        {(["system", "light", "dark"] as const).map((mode, index) => (
          <Pressable
            key={mode}
            accessibilityRole="radio"
            accessibilityLabel={{ system: "跟随系统", light: "浅色", dark: "深色" }[mode]}
            accessibilityState={{ checked: preferences.appearance === mode }}
            aria-checked={preferences.appearance === mode}
            onPress={() => setPreferences({ ...preferences, appearance: mode })}
            style={{
              minHeight: 54,
              paddingHorizontal: 16,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              borderTopWidth: index ? StyleSheet.hairlineWidth : 0,
              borderColor: c.line,
            }}
          >
            <Text style={{ color: c.text, fontSize: 15 }}>
              {{ system: "跟随系统", light: "浅色", dark: "深色" }[mode]}
            </Text>
            {preferences.appearance === mode && <Check size={19} color={c.text} />}
          </Pressable>
        ))}
      </View>
      <Text style={{ fontSize: 12, color: c.muted, marginTop: 12 }}>强调色</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="强调色"
        style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}
      >
        {Object.entries(accentNames).map(([key, name]) => {
          const accent = key as AppearancePreferences["accent"];
          return (
            <Pressable
              key={key}
              accessibilityRole="radio"
              accessibilityLabel={`强调色：${name}`}
              accessibilityState={{ checked: preferences.accent === accent }}
              aria-checked={preferences.accent === accent}
              onPress={() => setPreferences({ ...preferences, accent })}
              style={{ alignItems: "center", gap: 6, padding: 7 }}
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: resolveAppearance(
                    { ...preferences, accent },
                    theme.dark ? "dark" : "light",
                  ).colors.accent,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {preferences.accent === accent && <Check size={19} color={c.onAccent} />}
              </View>
              <Text style={{ fontSize: 12, color: c.muted }}>{name}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={{ fontSize: 12, color: c.muted, marginTop: 12 }}>
        兼容皮肤 · 选择后使用对应的固定外观
      </Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="控制端皮肤" style={styles.options}>
        {controlThemes.map((option) => {
          const selected =
              JSON.stringify(preferences) === JSON.stringify(appearanceForSkin(option.id)),
            palette = option.colors;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="radio"
              accessibilityLabel={option.name}
              accessibilityState={{ checked: selected }}
              aria-checked={selected}
              onPress={() => selectTheme(option.id)}
              style={({ pressed }) => [
                styles.option,
                {
                  borderColor: selected ? c.accent : c.line,
                  backgroundColor: c.surface,
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              <View
                pointerEvents="none"
                style={[styles.preview, { backgroundColor: palette.bg, borderColor: palette.line }]}
              >
                <View
                  style={[
                    styles.sidebar,
                    { backgroundColor: palette.sidebar, borderColor: palette.line },
                  ]}
                >
                  <View style={[styles.dot, { backgroundColor: palette.accent }]} />
                  {[0, 1, 2].map((row) => (
                    <View
                      key={row}
                      style={[
                        styles.sidebarLine,
                        { backgroundColor: row === 0 ? palette.soft : palette.line },
                      ]}
                    />
                  ))}
                </View>
                <View style={styles.conversation}>
                  <View style={[styles.message, { backgroundColor: palette.bubble }]} />
                  <View
                    style={[styles.textLine, { backgroundColor: palette.text, width: "85%" }]}
                  />
                  <View
                    style={[styles.textLine, { backgroundColor: palette.muted, width: "65%" }]}
                  />
                  <View style={[styles.code, { backgroundColor: palette.code }]}>
                    <View
                      style={[
                        styles.textLine,
                        { backgroundColor: palette.syntaxKeyword, width: "65%" },
                      ]}
                    />
                    <View
                      style={[
                        styles.textLine,
                        { backgroundColor: palette.diffAddedText, width: "85%" },
                      ]}
                    />
                  </View>
                  <View
                    style={[
                      styles.composer,
                      { backgroundColor: palette.composer, borderColor: palette.composerBorder },
                    ]}
                  />
                </View>
              </View>
              <View style={styles.caption}>
                <Text style={{ color: c.text, fontSize: 13, fontWeight: selected ? "600" : "400" }}>
                  {option.name}
                </Text>
                {selected && <Check size={15} color={c.accent} />}
              </View>
            </Pressable>
          );
        })}
      </View>
      <Text style={{ color: c.muted, fontSize: 12 }}>立即生效，记住此设备的选择</Text>
      {!!persistenceError && (
        <Text accessibilityRole="alert" style={{ color: c.danger, fontSize: 12 }}>
          {persistenceError}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10, marginBottom: 8 },
  options: { flexDirection: "row", gap: 8 },
  option: { flex: 1, minWidth: 0, borderWidth: 1.5, borderRadius: 12, padding: 6, gap: 8 },
  preview: {
    height: 98,
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 6,
    overflow: "hidden",
  },
  sidebar: { width: "25%", borderRightWidth: 1, padding: 4, gap: 5 },
  dot: { width: 5, height: 5, borderRadius: 3, marginBottom: 2 },
  sidebarLine: { height: 5, borderRadius: 2 },
  conversation: { flex: 1, padding: 7, gap: 5 },
  message: { height: 12, width: "65%", alignSelf: "flex-end", borderRadius: 4 },
  textLine: { height: 3, borderRadius: 2 },
  code: { padding: 5, gap: 4, borderRadius: 3, marginTop: 2 },
  composer: { height: 13, borderWidth: 1, borderRadius: 4, marginTop: "auto" },
  caption: {
    minHeight: 23,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 2,
    paddingHorizontal: 2,
    paddingBottom: 2,
  },
});
