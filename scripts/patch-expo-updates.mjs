import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Use Expo's persisted, allowlisted request-header override to select a Relay.
// Keep Expo's embedded fallback enabled when the Relay is offline or changes.
const require = createRequire(new URL("../apps/mobile/package.json", import.meta.url));
const root = dirname(require.resolve("expo-updates/package.json"));
const ios = "ios/EXUpdates/";
const android = "android/src/main/java/expo/modules/updates/";
const placeholder = "https://frogcoder.invalid/v1/mobile-ota/manifest";
const header = "frogcoder-update-url";
const patches = [
  [
    ios + "UpdatesConfig.swift",
    "    return getOriginalEmbeddedUpdateUrl(fromDictionary: config)\n  }",
    `    let originalUrl = getOriginalEmbeddedUpdateUrl(fromDictionary: config)
    if originalUrl?.absoluteString == "${placeholder}",
      let address = getRequestHeaders(fromDictionary: config, configOverride: configOverride)["${header}"],
      let url = URL(string: address), ["http", "https"].contains(url.scheme ?? ""),
      url.host != nil, url.user == nil, url.password == nil, url.fragment == nil,
      url.path == "/v1/mobile-ota/manifest" {
      return url
    }
    return originalUrl
  }`,
  ],
  [
    android + "UpdatesConfiguration.kt",
    "      return getOriginalEmbeddedUpdateUrl(context, overrideMap)\n    }",
    `      val originalUrl = getOriginalEmbeddedUpdateUrl(context, overrideMap)
      if (originalUrl?.toString() == "${placeholder}") {
        val headers = getRequestHeaders(context, overrideMap, disableAntiBrickingMeasures, configOverride)
        val url = headers["${header}"]?.let { Uri.parse(it) }
        if (url != null && url.scheme in listOf("http", "https") && !url.host.isNullOrEmpty() &&
          url.userInfo == null && url.fragment == null && url.path == "/v1/mobile-ota/manifest"
        ) return url
      }
      return originalUrl
    }`,
  ],
  [
    ios + "SelectionPolicy/LauncherSelectionPolicyFilterAware.swift",
    "      .filter { ($0.url == nil && $0.requestHeaders == nil) || ($0.url == config.updateUrl && $0.requestHeaders == config.requestHeaders) }",
    `      .filter {
        (config.originalEmbeddedUpdateUrl.absoluteString == "${placeholder}" &&
          config.hasEmbeddedUpdate && $0.status == .StatusEmbedded) ||
          ($0.url == nil && $0.requestHeaders == nil) ||
          ($0.url == config.updateUrl && $0.requestHeaders == config.requestHeaders)
      }`,
  ],
  [
    android + "selectionpolicy/LauncherSelectionPolicyFilterAware.kt",
    "      .filter { (it.url == null && it.requestHeaders == null) || (it.url == config.updateUrl && it.requestHeaders == config.requestHeaders) }",
    `      .filter {
        (config.originalEmbeddedUpdateUrl.toString() == "${placeholder}" &&
          config.hasEmbeddedUpdate && it.status == expo.modules.updates.db.enums.UpdateStatus.EMBEDDED) ||
          (it.url == null && it.requestHeaders == null) ||
          (it.url == config.updateUrl && it.requestHeaders == config.requestHeaders)
      }`,
  ],
  [
    ios + "AppLoader/FileDownloader.swift",
    "    var mutableManifest = manifest",
    `    if config.originalEmbeddedUpdateUrl.absoluteString == "${placeholder}" {
      let metadata = manifest["metadata"] as? [String: Any]
      guard metadata?["relayUpdateUrl"] as? String == config.updateUrl.absoluteString else {
        errorBlock(UpdatesError.fileDownloaderManifestParseFailed(cause: nil))
        return
      }
    }
    var mutableManifest = manifest`,
  ],
  [
    android + "loader/FileDownloader.kt",
    "    val update = UpdateFactory.getUpdate(preManifest, responseHeaderData, extensions, configuration)",
    `    if (configuration.originalEmbeddedUpdateUrl.toString() == "${placeholder}" &&
      preManifest.optJSONObject("metadata")?.optString("relayUpdateUrl") != configuration.updateUrl.toString()
    ) {
      throw IOException("The signed update belongs to a different Relay or Relay version")
    }
    val update = UpdateFactory.getUpdate(preManifest, responseHeaderData, extensions, configuration)`,
  ],
];

for (const [name, original, replacement] of patches) {
  const file = join(root, name);
  const source = readFileSync(file, "utf8");
  if (source.includes(replacement)) continue;
  if (source.split(original).length !== 2) {
    throw new Error(
      `Expo Updates changed at ${name}. Update the FrogCoder native integration before building.`,
    );
  }
  writeFileSync(
    file,
    source.replace(original, () => replacement),
  );
}
