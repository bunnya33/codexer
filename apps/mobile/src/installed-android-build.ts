import app from "../app.json";

export const installedAndroidBuild = {
  version: app.expo.version,
  buildNumber: app.expo.android.versionCode,
};
