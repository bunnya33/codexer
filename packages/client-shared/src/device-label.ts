export function deviceSystem(platform?: string): string {
  return (
    ({ win32: "Windows", darwin: "macOS", linux: "Linux" } as Record<string, string>)[
      platform ?? ""
    ] ?? "系统未上报"
  );
}
export function deviceDetails(
  device: { platform?: string; agentVersion?: string },
  snapshot?: { agentVersion?: string },
): string {
  return `${deviceSystem(device.platform)} · Agent ${snapshot?.agentVersion ?? device.agentVersion ?? "版本未上报"}`;
}
