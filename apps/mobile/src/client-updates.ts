import { useEffect, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { ClientUpdateChecker } from "../../../packages/client-shared/src/client-updates";
import { clientUpdateAvailable } from "../../../packages/shared/src/client-release";
import type { ClientTarget } from "../../../packages/shared/src/client-release";
import { relay } from "./relay";
import { controlVersion } from "./build-info";
import appConfig from "../app.json";
import { downloadClientUpdate } from "./client-update-download";
import type { ClientUpdatePhase } from "./client-update-state";
const checker = new ClientUpdateChecker();
let consumers = 0;
const connectionKey = () => {
  const view = relay.getSnapshot();
  return view.phase === "locked" ? "" : JSON.stringify([view.url, view.userId]);
};
export function useClientUpdates() {
  const connection = useSyncExternalStore(relay.subscribe, relay.getSnapshot),
    state = useSyncExternalStore(checker.subscribe, checker.getSnapshot);
  const target: ClientTarget | undefined =
    Platform.OS === "android" ? "control-android" : undefined;
  useEffect(() => {
    consumers++;
    checker.configure(connectionKey(), target, (signal) => relay.clientRelease(target!, signal));
    return () => {
      if (--consumers === 0) checker.dispose();
    };
  }, [connection.url, connection.userId, connection.phase === "locked", target]);
  return {
    ...state,
    available: clientUpdateAvailable(
      state.release,
      controlVersion,
      appConfig.expo.android.versionCode,
    ),
    version: controlVersion,
    check: () => checker.check(),
    download: async (
      signal: AbortSignal,
      progress: (value: number) => void,
      phase?: (value: ClientUpdatePhase) => void,
    ) => {
      const key = connectionKey(),
        abort = new AbortController();
      const cancel = () => abort.abort();
      signal.addEventListener("abort", cancel, { once: true });
      const off = relay.subscribe(() => {
        if (connectionKey() !== key) abort.abort();
      });
      try {
        if (signal.aborted) abort.abort();
        await checker.check();
        if (abort.signal.aborted) throw new Error("下载已取消");
        const release = checker.getSnapshot().release;
        if (!clientUpdateAvailable(release, controlVersion, appConfig.expo.android.versionCode))
          throw new Error("没有可下载的新版本");
        return await downloadClientUpdate(
          relay.clientInstallerSource(release!.target, release!.id),
          release!,
          abort.signal,
          progress,
          phase,
        );
      } finally {
        off();
        signal.removeEventListener("abort", cancel);
      }
    },
  };
}
