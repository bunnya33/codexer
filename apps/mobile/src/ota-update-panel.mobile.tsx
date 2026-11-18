import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import * as Updates from "expo-updates";
import { relay } from "./relay";
import { useTheme } from "./styles";

export function OtaUpdatePanel() {
  const { phase, url, userId } = useSyncExternalStore(relay.subscribe, relay.getSnapshot);
  if (!Updates.isEnabled || phase === "locked" || !url || !userId) return null;
  return <EnabledUpdatePanel key={JSON.stringify([url, userId])} url={url} userId={userId} />;
}

function EnabledUpdatePanel({ url, userId }: { url: string; userId: string }) {
  const { c } = useTheme();
  const update = Updates.useUpdates();
  const live = useRef(true);
  const busy = useRef(false);
  const checkedSource = useRef("");
  const statusRequest = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking" | "downloading" | "prompt" | "restarting">(
    "idle",
  );
  const [available, setAvailable] = useState(false);
  const [pending, setPending] = useState("");
  const [ignoredSource, setIgnoredSource] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      statusRequest.current?.abort();
    };
  }, []);

  const stillConnected = () => {
    const current = relay.getSnapshot();
    return (
      live.current && current.phase !== "locked" && current.url === url && current.userId === userId
    );
  };
  const readSource = async () => {
    const request = new AbortController();
    statusRequest.current = request;
    try {
      const version = await relay.mobileOtaVersion(request.signal);
      return version ? `${url}/v1/mobile-ota/manifest?relayVersion=${version}` : "";
    } finally {
      statusRequest.current = null;
    }
  };
  const downloadedManifest = update.downloadedUpdate?.manifest;
  const metadata =
    downloadedManifest && "metadata" in downloadedManifest
      ? downloadedManifest.metadata
      : undefined;
  const downloaded =
    update.isUpdatePending && metadata && "relayUpdateUrl" in metadata
      ? metadata.relayUpdateUrl
      : undefined;
  const cachedSource = pending || (typeof downloaded === "string" ? downloaded : "");
  const ready =
    cachedSource !== ignoredSource &&
    cachedSource.startsWith(url + "/v1/mobile-ota/manifest?relayVersion=");
  const operating =
    phase !== "idle" || update.isChecking || update.isDownloading || update.isRestarting;
  const check = async () => {
    if (busy.current || operating || ready) return;
    busy.current = true;
    setPhase("checking");
    setError("");
    setNote("");
    try {
      const source = await readSource();
      if (!stillConnected()) return;
      checkedSource.current = source;
      setAvailable(false);
      if (!source) {
        setNote("当前服务器暂不支持内容更新");
        return;
      }
      Updates.setUpdateRequestHeadersOverride({ "frogcoder-update-url": source });
      const result = await Updates.checkForUpdateAsync();
      if (!stillConnected()) return;
      setAvailable(result.isAvailable);
      setNote(result.isAvailable ? "发现内容更新" : "当前服务器没有适配此安装包的内容更新");
    } catch {
      if (live.current) {
        setAvailable(false);
        setError("暂时无法检查内容更新，请重试。");
      }
    } finally {
      busy.current = false;
      if (live.current) setPhase("idle");
    }
  };

  const apply = async () => {
    if (busy.current || operating) return;
    busy.current = true;
    setError("");
    try {
      const source = await readSource();
      if (!stillConnected()) return;
      if (!source || source !== (ready ? cachedSource : checkedSource.current)) {
        Updates.setUpdateRequestHeadersOverride(null);
        setIgnoredSource(cachedSource);
        setPending("");
        setAvailable(false);
        setNote("服务器版本已变化，请重新检查内容更新");
        return;
      }
      Updates.setUpdateRequestHeadersOverride({ "frogcoder-update-url": source });
      if (!ready) {
        setPhase("downloading");
        const result = await Updates.fetchUpdateAsync();
        if (!stillConnected()) return;
        setAvailable(false);
        if (!result.isNew) {
          setNote("当前没有可下载的内容更新");
          return;
        }
        setPending(source);
        setIgnoredSource("");
        setNote("更新已下载，下次启动时生效");
      }
      setPhase("prompt");
      const restart = await new Promise<boolean>((resolve) => {
        Alert.alert(
          "更新已就绪",
          "立即重启 FrogCoder，或在下次启动时使用新版。",
          [
            { text: "下次启动", style: "cancel", onPress: () => resolve(false) },
            { text: "立即重启", onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        );
      });
      if (!restart || !stillConnected()) return;
      setPhase("restarting");
      try {
        await Updates.reloadAsync();
      } catch {
        if (live.current) setError("暂时无法重启，下次启动时会应用已下载的更新。");
      }
    } catch {
      if (live.current) setError("内容更新下载失败，请重试。");
    } finally {
      busy.current = false;
      if (live.current) setPhase("idle");
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ color: c.text, flex: 1 }}>内容更新</Text>
        {operating && <ActivityIndicator color={c.accent} />}
        <Pressable
          accessibilityRole="button"
          disabled={operating || ready}
          onPress={() => void check()}
          style={{ padding: 12 }}
        >
          <Text style={{ color: operating || ready ? c.muted : c.accent }}>检查内容更新</Text>
        </Pressable>
      </View>
      {(available || ready) && (
        <Pressable
          accessibilityRole="button"
          disabled={operating}
          onPress={() => void apply()}
          style={{
            padding: 12,
            borderRadius: 8,
            backgroundColor: c.accent,
            opacity: operating ? 0.6 : 1,
          }}
        >
          <Text style={{ color: c.onAccent, textAlign: "center" }}>
            {phase === "downloading" ? "正在下载内容…" : ready ? "应用已下载更新" : "下载内容更新"}
          </Text>
        </Pressable>
      )}
      {!!note && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.muted }}>
          {note}
        </Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: c.danger }}>
          {error}
        </Text>
      )}
    </View>
  );
}
