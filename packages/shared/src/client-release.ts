import { z } from "zod";

export const CLIENT_TARGETS = {
  "agent-windows-x64-setup": "Agent · Windows x64 安装版",
  "agent-windows-x64-portable": "Agent · Windows x64 便携版",
  "agent-macos-arm64": "Agent · macOS Apple Silicon",
  "agent-macos-x64": "Agent · macOS Intel",
  "control-windows-x64": "Control · Windows x64",
  "control-macos-arm64": "Control · macOS Apple Silicon",
  "control-macos-x64": "Control · macOS Intel",
  "control-android": "Control · Android APK",
} as const;
export type ClientTarget = keyof typeof CLIENT_TARGETS;
export const MAX_CLIENT_RELEASE_BYTES = 512 * 1024 * 1024;
export const clientReleaseSchema = z.object({
  id: z.string().uuid(),
  target: z.enum(Object.keys(CLIENT_TARGETS) as [ClientTarget, ...ClientTarget[]]),
  name: z.string().min(1).max(180),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  buildNumber: z.number().int().nonnegative().max(2147483647),
  notes: z.string().max(2000),
  size: z.number().int().positive().max(MAX_CLIENT_RELEASE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  uploadedAt: z.number(),
});
export type ClientRelease = z.infer<typeof clientReleaseSchema>;
export function newerClientVersion(latest: string, installed: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(latest) || !/^\d+\.\d+\.\d+$/.test(installed)) return false;
  const parts = (value: string) => value.split(".").map((part) => part.replace(/^0+(?=\d)/, ""));
  const a = parts(latest),
    b = parts(installed);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i])
      return a[i]!.length === b[i]!.length ? a[i]! > b[i]! : a[i]!.length > b[i]!.length;
  }
  return false;
}
export function clientUpdateAvailable(
  release: ClientRelease | null,
  version: string,
  buildNumber?: number,
) {
  return (
    !!release &&
    (buildNumber === undefined
      ? newerClientVersion(release.version, version)
      : release.buildNumber > buildNumber &&
        (release.version === version || newerClientVersion(release.version, version)))
  );
}
export type ClientUpdateState = {
  checking: boolean;
  release: ClientRelease | null;
  checkedAt: number | null;
  error: string;
};
export const emptyClientUpdate = (): ClientUpdateState => ({
  checking: false,
  release: null,
  checkedAt: null,
  error: "",
});
export const CLIENT_UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
