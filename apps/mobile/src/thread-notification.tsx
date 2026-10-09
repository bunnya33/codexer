import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { historyKey, relay } from "./relay";
import { c } from "./styles";

export function useThreadNotification({
  deviceId,
  threadId,
}: {
  deviceId: string;
  threadId: string;
}) {
  const view = useSyncExternalStore(relay.subscribe, relay.getSnapshot);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const key = historyKey(deviceId, threadId);
  const currentKey = useRef(key);
  currentKey.current = key;
  const notification = view.threadNotifications[key];
  useEffect(() => {
    let active = true;
    setPending(false);
    setError("");
    if (view.role !== "user" || !deviceId || !threadId || view.phase !== "connected") return;
    const refresh = () => {
      void relay
        .loadThreadNotification(deviceId, threadId)
        .then(() => {
          if (active) setError("");
        })
        .catch(() => {
          if (active) setError("通知设置读取失败，点击重试");
        });
    };
    refresh();
    // 重连会刷新；定期校准还可覆盖其它客户端解绑、绑定和离线修改。
    const timer = setInterval(refresh, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [deviceId, threadId, view.role, view.phase]);
  const change = async (enabled: boolean) => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await relay.setThreadNotification(deviceId, threadId, enabled);
    } catch {
      if (currentKey.current === key) setError("保存失败，请重试");
    } finally {
      if (currentKey.current === key) setPending(false);
    }
  };
  const hint =
    error ||
    (notification && !notification.available
      ? "服务器未开启微信接入"
      : notification?.allEnabled
        ? "总开关已开启，全部会话都会通知"
        : notification && !notification.bound
          ? "需在设置中绑定微信"
          : "仅通知本会话，设置随账号同步");
  const retry = () => {
    void relay
      .loadThreadNotification(deviceId, threadId)
      .then(() => {
        if (currentKey.current === key) setError("");
      })
      .catch(() => {
        if (currentKey.current === key) setError("通知设置读取失败，点击重试");
      });
  };
  return {
    notification,
    pending,
    error,
    hint,
    change,
    retry,
    visible: view.role === "user" && !!deviceId && !!threadId,
    connected: view.phase === "connected",
  };
}

export function ThreadNotificationToggle({
  control,
}: {
  control: ReturnType<typeof useThreadNotification>;
}) {
  if (!control.visible) return null;
  return (
    <View style={ns.container}>
      <View style={ns.row}>
        <Text style={ns.label}>本会话微信通知</Text>
        <Switch
          accessibilityLabel="本会话微信通知"
          value={control.notification?.enabled ?? false}
          disabled={control.pending || !control.notification || !control.connected}
          onValueChange={(value) => void control.change(value)}
          trackColor={{ true: c.accent }}
        />
      </View>
      <Pressable
        disabled={!control.error}
        onPress={control.retry}
        accessibilityRole={control.error ? "button" : undefined}
      >
        <Text style={[ns.description, !!control.error && { color: c.danger }]}>{control.hint}</Text>
      </Pressable>
    </View>
  );
}

const ns = StyleSheet.create({
  container: { gap: 6, paddingVertical: 14 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  description: { fontSize: 12, lineHeight: 18, color: c.muted },
  label: { flex: 1, fontSize: 14, color: c.text },
});
