import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { useClientUpdates } from "./client-updates";
import { useTheme } from "./styles";
import type { ClientUpdatePhase } from "./client-update-state";
export function ClientUpdatePanel() {
  const { c } = useTheme(),
    updates = useClientUpdates(),
    task = useRef<AbortController | null>(null),
    live = useRef(true);
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [phase, setPhase] = useState<ClientUpdatePhase>("downloading"),
    [note, setNote] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      task.current?.abort();
    };
  }, []);
  if (Platform.OS === "web")
    return (
      <Text style={{ color: c.muted }}>网页控制端随服务器更新，刷新页面即可加载已发布的版本。</Text>
    );
  return (
    <View style={{ gap: 14 }}>
      <Text style={{ color: c.text, fontSize: 15 }}>当前版本 {updates.version}</Text>
      <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
        {updates.checking && <ActivityIndicator color={c.accent} />}
        <Text style={{ color: c.text, flex: 1 }}>
          {updates.available
            ? `发现新版本 ${updates.release?.version}`
            : updates.error
              ? "暂时无法检查更新"
              : updates.checkedAt
                ? "已是最新版本"
                : "尚未检查更新"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="检查客户端更新"
          disabled={busy || updates.checking}
          onPress={() => {
            if (task.current) return;
            setError("");
            void updates.check().catch(() => {
              if (live.current) setError("检查失败，请重试");
            });
          }}
          style={{ padding: 12 }}
        >
          <Text style={{ color: c.accent }}>检查更新</Text>
        </Pressable>
      </View>
      {!!updates.release?.notes && (
        <Text selectable style={{ color: c.muted, lineHeight: 22 }}>
          {updates.release.notes}
        </Text>
      )}
      {updates.available && (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => {
            if (task.current) return;
            const abort = new AbortController();
            task.current = abort;
            setBusy(true);
            setProgress(0);
            setPhase("downloading");
            setNote("");
            setError("");
            void updates
              .download(
                abort.signal,
                (value) => {
                  if (live.current) setProgress(value);
                },
                (value) => {
                  if (live.current) setPhase(value);
                },
              )
              .then((result) => {
                if (live.current && !abort.signal.aborted)
                  setNote(
                    result === "permission-required"
                      ? "请在系统设置中允许安装此来源的应用，返回后点击重试安装。安装包已保留。"
                      : "已打开系统安装程序，请按系统提示完成安装。",
                  );
              })
              .catch((value) => {
                if (live.current)
                  setError(value instanceof Error ? value.message : "下载失败，请重试");
              })
              .finally(() => {
                task.current = null;
                if (live.current) setBusy(false);
              });
          }}
          style={{ padding: 15, borderRadius: 12, backgroundColor: c.accent }}
        >
          <Text style={{ color: c.onAccent, textAlign: "center" }}>
            {busy
              ? phase === "verifying"
                ? "正在校验安装包…"
                : phase === "installing"
                  ? "正在打开安装程序…"
                  : progress >= 1
                    ? "下载完成，正在准备校验…"
                    : `正在下载 ${Math.floor(progress * 100)}%`
              : note
                ? "重试安装"
                : "下载更新"}
          </Text>
        </Pressable>
      )}
      {busy && phase !== "installing" && (
        <Pressable
          accessibilityRole="button"
          onPress={() => task.current?.abort()}
          style={{ padding: 12, alignSelf: "center" }}
        >
          <Text style={{ color: c.accent }}>取消更新</Text>
        </Pressable>
      )}
      {!!note && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.muted, lineHeight: 22 }}>
          {note}
        </Text>
      )}
      {!!(error || updates.error) && (
        <Text accessibilityRole="alert" style={{ color: c.danger }}>
          {error || updates.error}
        </Text>
      )}
      <Text style={{ fontSize: 12, color: c.muted, lineHeight: 19 }}>
        {Platform.OS === "android"
          ? "下载完成后打开系统安装程序。首次安装需允许此应用安装更新，然后返回重试。"
          : "下载完成后打开系统安装程序，保留当前登录和设备配置。"}
        更新提示会在安装新版后消失。
      </Text>
    </View>
  );
}
