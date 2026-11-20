import {
  createContext, useContext, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { ActivityIndicator, Alert, AppState, Pressable, Text, View } from "react-native";
import * as Updates from "expo-updates";
import { relay } from "./relay";
import { useTheme } from "./styles";

const checkInterval = 5 * 60 * 1000;
const connectionKey = () => {
  const { phase, url, userId } = relay.getSnapshot();
  return phase !== "locked" && url && userId ? JSON.stringify([url, userId]) : "";
};
type Session = {
  url: string;
  checkedSource: string;
  request?: AbortController;
};
type UpdateState = {
  phase: "idle" | "checking" | "downloading" | "prompt" | "restarting";
  available: boolean;
  pending: { source: string; id: string } | null;
  ignoredSource: string;
  note: string;
  error: string;
};
const initialState: UpdateState = {
  phase: "idle", available: false, pending: null, ignoredSource: "", note: "", error: "",
};
type PanelState = UpdateState & {
  currentLabel: string;
  ready: boolean;
  operating: boolean;
  check: () => void;
  apply: () => void;
};
const PanelContext = createContext<PanelState | null>(null);
const AvailableContext = createContext(false);
export const useOtaUpdateAvailable = () => useContext(AvailableContext);
export const otaUpdatesSupported = Updates.isEnabled;

export function OtaUpdateProvider({ children }: { children: ReactNode }) {
  return Updates.isEnabled ? <EnabledUpdateProvider>{children}</EnabledUpdateProvider> : children;
}

function EnabledUpdateProvider({ children }: { children: ReactNode }) {
  const key = useSyncExternalStore(relay.subscribe, connectionKey, connectionKey);
  const session = useMemo<Session | null>(() => key ? { url: JSON.parse(key)[0], checkedSource: "" } : null, [key]);
  const update = Updates.useUpdates();
  const [entry, setEntry] = useState<{ session: Session; state: UpdateState }>();
  const state = entry && entry.session === session ? entry.state : initialState;
  const { phase, available, pending, ignoredSource } = state;
  const mountedSession = useRef<Session | null>(null);
  const operation = useRef<Promise<void> | null>(null);
  const stillConnected = () => session && mountedSession.current === session && connectionKey() === key;
  const publish = (patch: Partial<UpdateState>) => {
    if (!session || !stillConnected()) return;
    setEntry(previous => ({
      session,
      state: { ...(previous?.session === session ? previous.state : initialState), ...patch },
    }));
  };

  const runningId = update.currentlyRunning?.updateId?.toLowerCase();
  const runningManifest = update.currentlyRunning?.manifest;
  const runningMetadata = runningManifest && "metadata" in runningManifest ? runningManifest.metadata : undefined;
  const currentLabel = runningMetadata && "releaseLabel" in runningMetadata && typeof runningMetadata.releaseLabel === "string"
    ? runningMetadata.releaseLabel : "";
  const manifest = update.downloadedUpdate?.manifest;
  const metadata = manifest && "metadata" in manifest ? manifest.metadata : undefined;
  const downloaded = update.isUpdatePending ? update.downloadedUpdate : undefined;
  const source = metadata && "relayUpdateUrl" in metadata && typeof metadata.relayUpdateUrl === "string"
    ? metadata.relayUpdateUrl : "";
  const cached = pending ?? (downloaded?.updateId && source ? { source, id: downloaded.updateId } : null);
  const cachedSource = cached && cached.id.toLowerCase() !== runningId ? cached.source : "";
  const ready = !!session && cachedSource !== ignoredSource &&
    cachedSource.startsWith(session.url + "/v1/mobile-ota/manifest?relayVersion=");
  const operating = phase !== "idle" || update.isChecking || update.isDownloading || update.isRestarting;

  const readSource = async (current: Session) => {
    const request = new AbortController();
    current.request = request;
    try {
      const version = await relay.mobileOtaVersion(request.signal);
      return version ? `${current.url}/v1/mobile-ota/manifest?relayVersion=${version}` : "";
    } finally {
      current.request = undefined;
    }
  };
  const run = (task: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = task().finally(() => {
      operation.current = null;
      publish({ phase: "idle" });
    });
  };

  const check = (manual = true) => {
    if (!session || !stillConnected()) return;
    run(async () => {
      publish(manual ? { phase: "checking", error: "", note: "" } : { phase: "checking" });
      try {
        const source = await readSource(session);
        if (!stillConnected()) return;
        if (session.checkedSource !== source) publish({ available: false });
        if (ready && cachedSource !== source) {
          Updates.setUpdateRequestHeadersOverride(null);
          publish({ pending: null, ignoredSource: cachedSource, available: false });
        }
        if (!source) {
          session.checkedSource = "";
          publish({ available: false, note: "当前服务器暂不支持内容更新" });
          return;
        }
        Updates.setUpdateRequestHeadersOverride({ "frogcoder-update-url": source });
        const result = await Updates.checkForUpdateAsync();
        if (!stillConnected()) return;
        session.checkedSource = source;
        const downloadedForSource = ready && cachedSource === source;
        const advertisedId = result.manifest?.id?.toLowerCase();
        const available = result.isAvailable && !!advertisedId && advertisedId !== runningId;
        publish({
          available,
          error: "",
          note: downloadedForSource ? "更新已下载，下次启动时生效" : available ?
            "发现内容更新" : "热更新已是最新",
        });
      } catch {
        if (manual) publish({ error: "暂时无法检查内容更新，请重试。" });
      }
    });
  };

  const checkInForeground = useEffectEvent(async (current: Session) => {
    await operation.current;
    if (mountedSession.current === current && (AppState.currentState === "active" || AppState.currentState == null)) {
      check(false);
    }
  });
  useEffect(() => {
    mountedSession.current = session;
    if (!session) return;
    let foreground = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const onStateChange = (next: string | null) => {
      const active = next === "active" || next === null;
      if (active === foreground) return;
      foreground = active;
      clearInterval(timer);
      if (foreground) {
        const checkNow = () => { void checkInForeground(session); };
        checkNow();
        timer = setInterval(checkNow, checkInterval);
      }
    };
    onStateChange(AppState.currentState);
    const listener = AppState.addEventListener("change", onStateChange);
    return () => {
      mountedSession.current = null;
      session.request?.abort();
      clearInterval(timer);
      listener.remove();
    };
  }, [session]);

  const apply = () => {
    if (!session || !stillConnected() || operating || (!available && !ready)) return;
    run(async () => {
      publish({ phase: "downloading", error: "" });
      try {
        const source = await readSource(session);
        if (!stillConnected()) return;
        if (!source || source !== (ready ? cachedSource : session.checkedSource)) {
          Updates.setUpdateRequestHeadersOverride(null);
          publish({
            ignoredSource: cachedSource, pending: null, available: false,
            note: "服务器版本已变化，请重新检查内容更新",
          });
          return;
        }
        Updates.setUpdateRequestHeadersOverride({ "frogcoder-update-url": source });
        if (!ready) {
          const result = await Updates.fetchUpdateAsync();
          if (!stillConnected()) return;
          const id = result.manifest?.id;
          if (!result.isNew || !id || id.toLowerCase() === runningId) {
            publish({ available: false, note: "当前没有可下载的内容更新" });
            return;
          }
          publish({ available: false, pending: { source, id }, ignoredSource: "", note: "更新已下载，下次启动时生效" });
        }
        publish({ phase: "prompt" });
        const restart = await promptRestart();
        if (!restart || !stillConnected()) return;
        publish({ phase: "restarting" });
        try {
          await Updates.reloadAsync();
        } catch {
          publish({ error: "暂时无法重启，下次启动时会应用已下载的更新。" });
        }
      } catch {
        publish({ error: "内容更新下载失败，请重试。" });
      }
    });
  };

  return (
    <AvailableContext.Provider value={!!session && (available || ready)}>
      <PanelContext.Provider value={session ? { ...state, currentLabel, check, apply, operating, ready } : null}>
        {children}
      </PanelContext.Provider>
    </AvailableContext.Provider>
  );
}

function promptRestart() {
  return new Promise<boolean>(resolve => {
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
}

export function OtaUpdatePanel() {
  const { c } = useTheme();
  const state = useContext(PanelContext);
  if (!state) return null;
  const { phase, available, ready, operating, check, apply, note, error, currentLabel } = state;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ color: c.text, flex: 1 }}>{currentLabel ? `当前热更新 ${currentLabel}` : "安装包内置内容"}</Text>
        {operating && <ActivityIndicator color={c.accent} />}
        <Pressable
          accessibilityRole="button"
          disabled={operating}
          onPress={() => void check()}
          style={{ padding: 12 }}
        >
          <Text style={{ color: operating ? c.muted : c.accent }}>检查内容更新</Text>
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
