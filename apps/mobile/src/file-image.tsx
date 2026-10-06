import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { fileImageMime } from "../../../packages/client-shared/src/file-links";
import type { FileInfo } from "../../../packages/protocol/src/files";
import { ImageViewerImage } from "./image-viewer";
import { fileError, fileResponse } from "./file-transfer";
import type { FileSource } from "./file-transfer";

/** 文件图片只回源预览，不进入 Relay 图片缓存或文件存储。 */
export function FileImage({
  source,
  info,
  onClose,
}: {
  source: FileSource;
  info: FileInfo;
  onClose: () => void;
}) {
  const mimeType = fileImageMime(info.name)!;
  const nativeSvg = Platform.OS !== "web" && mimeType === "image/svg+xml";
  const [svg, setSvg] = useState<{ xml?: string; error?: string }>({});
  useEffect(() => {
    if (!nativeSvg) return;
    const controller = new AbortController();
    setSvg({});
    void (async () => {
      const response = await fileResponse(source, controller.signal);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== info.size) throw new Error("invalid-file-response");
      const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!xml.trim()) throw new Error("图片文件内容为空，无法预览");
      if (!controller.signal.aborted) setSvg({ xml });
    })().catch((error) => {
      if (!controller.signal.aborted) setSvg({ error: fileError(error) });
    });
    return () => controller.abort();
  }, [nativeSvg, source.uri, source.headers.authorization, info.size]);
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#101616" }}>
      {nativeSvg && !svg.xml ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 20 }}>
          {svg.error ? (
            <Text accessibilityRole="alert" style={{ color: "#fff" }}>
              {svg.error}
            </Text>
          ) : (
            <ActivityIndicator color="#fff" />
          )}
        </View>
      ) : (
        <ImageViewerImage
          key={source.uri}
          preview={{
            name: info.name,
            source: { ...source, mimeType, expectedBytes: info.size },
            svgXml: svg.xml,
          }}
          onClose={onClose}
        />
      )}
    </GestureHandlerRootView>
  );
}
