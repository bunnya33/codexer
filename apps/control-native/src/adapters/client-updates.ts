import { useEffect, useState } from "react";
import { request, subscribe } from "../bridge";
import type { DesktopUpdateState } from "../../../desktop/src/client-updates";
import { controlVersion } from "./build-info";
import type {
  ClientInstallResult,
  ClientUpdatePhase,
} from "../../../mobile/src/client-update-state";
const empty: DesktopUpdateState = {
  checking: false,
  release: null,
  checkedAt: null,
  error: "",
  available: false,
  downloading: false,
  progress: 0,
  downloaded: false,
  version: controlVersion,
};
export function useClientUpdates() {
  const [state, setState] = useState(empty);
  useEffect(() => {
    let live = true;
    void request<DesktopUpdateState>("updates.state")
      .then((value) => {
        if (live) setState(value);
      })
      .catch(() => {});
    const off = subscribe("clientUpdate", (value) => {
      if (live) setState(value);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return {
    ...state,
    check: () => request<void>("updates.check"),
    download: async (
      signal: AbortSignal,
      _progress: (value: number) => void,
      phase?: (value: ClientUpdatePhase) => void,
    ): Promise<ClientInstallResult | undefined> => {
      if (signal.aborted) return;
      const cancel = () => {
        void request("updates.cancel").catch(() => {});
      };
      const off = subscribe("clientUpdate", (value: DesktopUpdateState) =>
        _progress(value.progress),
      );
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await request("updates.download");
        if (!signal.aborted) {
          phase?.("installing");
          await request("updates.open");
          return "opened" as const;
        }
      } finally {
        off();
        signal.removeEventListener("abort", cancel);
      }
    },
  };
}
