import { requireOptionalNativeModule } from "expo-modules-core";
import app from "../app.json";

function readInstalledBuild() {
  // ExponentConstants reads app.config from the APK assets even during an OTA launch.
  const embedded = requireOptionalNativeModule<{ manifest?: string }>("ExponentConstants")?.manifest;
  if (!embedded) return;
  try {
    const { version, android } = JSON.parse(embedded);
    if (typeof version === "string" && Number.isSafeInteger(android?.versionCode) && android.versionCode > 0)
      return { version, buildNumber: android.versionCode };
  } catch {
    // Keep the build-time version in environments without the embedded Expo configuration.
  }
}

export const installedAndroidBuild = readInstalledBuild() ?? {
  version: app.expo.version,
  buildNumber: app.expo.android.versionCode,
};
