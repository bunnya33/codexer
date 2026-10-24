import React, { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { useTheme } from "../../../mobile/src/styles";
import { request, subscribe } from "../bridge";

export function WindowClosePreference() {
  const { c } = useTheme();
  const [closeExits, setCloseExits] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void request<{ closeExits: boolean }>("preferences.read")
      .then((value) => {
        if (active) setCloseExits(value.closeExits);
      })
      .catch(() => {
        if (active) setError("设置读取失败，请重试");
      });
    const off = subscribe("preferences", (value) => setCloseExits(value.closeExits));
    return () => {
      active = false;
      off();
    };
  }, []);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={{ color: c.text }}>关闭窗口时退出进程</Text>
          <Text style={{ fontSize: 12, color: c.muted }}>
            默认缩小到托盘。启用后，每次退出均需确认。
          </Text>
        </View>
        <Switch
          accessibilityLabel="关闭窗口时退出进程"
          value={closeExits}
          trackColor={{ true: c.accent }}
          onValueChange={(value) => {
            void request("preferences.save", { closeExits: value })
              .then(() => {
                setCloseExits(value);
                setError("");
              })
              .catch(() => setError("设置保存失败，请重试"));
          }}
        />
      </View>
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: c.danger }}>
          {error}
        </Text>
      )}
    </View>
  );
}
