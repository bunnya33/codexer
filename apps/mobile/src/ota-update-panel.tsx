import type { ReactNode } from "react";

export const otaUpdatesSupported = false;

export function OtaUpdatePanel() {
  return null;
}

export function OtaUpdateProvider({ children }: { children: ReactNode }) {
  return children;
}

export function useOtaUpdateAvailable() {
  return false;
}
