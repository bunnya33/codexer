import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Download, X } from "lucide-react-native";
import { fileName, fileReaderKind, fileSize } from "../../../packages/client-shared/src/file-links";
import { MAX_FILE_PREVIEW_BYTES } from "../../../packages/protocol/src/files";
import type { FileInfo } from "../../../packages/protocol/src/files";
import { FileLinkContext } from "./file-link-context";
import { fileError, previewFile } from "./file-transfer";
import { downloadFile } from "./file-download";
import { Markdown } from "./markdown";
import { CodeBlock } from "./code-block";
import { relay } from "./relay";
import { c } from "./styles";

type OpenFile = {
  path: string;
  info?: FileInfo;
  phase: "loading" | "preview" | "confirm" | "downloading" | "done" | "error";
  text?: string;
  message?: string;
  progress?: number;
};

/** 一个会话共用阅读器；切换会话、关闭或打开另一文件时取消旧请求。 */
export function FileViewerProvider({
  deviceId,
  threadId,
  children,
}: {
  deviceId: string;
  threadId: string;
  children: ReactNode;
}) {
  const [file, setFile] = useState<OpenFile>();
  const operation = useRef<AbortController | undefined>(undefined);
  const close = useCallback(() => {
    operation.current?.abort();
    operation.current = undefined;
    setFile(undefined);
  }, []);
  useEffect(() => {
    close();
    return () => {
      operation.current?.abort();
    };
  }, [deviceId, threadId, close]);
  const open = useCallback(
    (path: string) => {
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      const current = () => !controller.signal.aborted && operation.current === controller;
      setFile({ path, phase: "loading" });
      void (async () => {
        try {
          const info = await relay.fileInfo(deviceId, threadId, path, controller.signal);
          if (!current()) return;
          if (fileReaderKind(info.name) === "download" || info.size > MAX_FILE_PREVIEW_BYTES) {
            setFile({
              path,
              info,
              phase: "confirm",
              message:
                info.size > MAX_FILE_PREVIEW_BYTES && fileReaderKind(info.name) !== "download"
                  ? "文件较大，请下载后查看。是否下载此文件？"
                  : "是否下载此文件？",
            });
            return;
          }
          setFile({ path, info, phase: "loading" });
          try {
            const text = await previewFile(
              relay.fileSource(deviceId, threadId, path, info.version),
              info,
              controller.signal,
            );
            if (current()) setFile({ path, info, phase: "preview", text });
          } catch (error) {
            if (!current()) return;
            const message = fileError(error);
            if (message === "无法按 UTF-8 文本读取，请下载后查看")
              setFile({ path, info, phase: "confirm", message: `${message}。是否下载此文件？` });
            else throw error;
          }
        } catch (error) {
          if (current()) setFile({ path, phase: "error", message: fileError(error) });
        }
      })();
    },
    [deviceId, threadId],
  );

  const download = async () => {
    if (!file?.info || !["preview", "confirm"].includes(file.phase)) return;
    const { info, path } = file;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const current = () => !controller.signal.aborted && operation.current === controller;
    setFile({ path, info, phase: "downloading" });
    try {
      await downloadFile(
        relay.fileSource(deviceId, threadId, path, info.version),
        info,
        controller.signal,
        (progress) => {
          if (current()) setFile({ path, info, phase: "downloading", progress });
        },
      );
      if (current())
        setFile({
          path,
          info,
          phase: "done",
          message: "文件已交给系统保存，请查看下载或保存位置。",
        });
    } catch (error) {
      if (current()) setFile({ path, phase: "error", message: fileError(error) });
    }
  };

  return (
    <FileLinkContext.Provider value={open}>
      {children}
      <Modal visible={!!file} animationType="fade" transparent onRequestClose={close}>
        <View style={fs.backdrop}>
          <SafeAreaView style={fs.reader}>
            <View style={fs.header}>
              <View style={fs.heading}>
                <Text accessibilityRole="header" style={fs.title} numberOfLines={2}>
                  {file?.info?.name ?? fileName(file?.path ?? "")}
                </Text>
                {file?.info && <Text style={fs.meta}>{fileSize(file.info.size)}</Text>}
              </View>
              {file?.phase === "preview" && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="下载文件"
                  onPress={() => void download()}
                  style={fs.icon}
                >
                  <Download size={20} color={c.accent} />
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭文件"
                onPress={close}
                style={fs.icon}
              >
                <X size={22} color={c.text} />
              </Pressable>
            </View>
            <ScrollView style={fs.body} contentContainerStyle={fs.content}>
              {file?.phase === "preview" && (
                <FileLinkContext.Provider value={undefined}>
                  {fileReaderKind(file.info!.name) === "markdown" ? (
                    <Markdown>{file.text ?? ""}</Markdown>
                  ) : fileReaderKind(file.info!.name) === "json" ? (
                    <CodeBlock language="json">{file.text ?? ""}</CodeBlock>
                  ) : (
                    <Text selectable style={fs.text}>
                      {file.text}
                    </Text>
                  )}
                </FileLinkContext.Provider>
              )}
              {(file?.phase === "loading" || file?.phase === "downloading") && (
                <View style={fs.status}>
                  <ActivityIndicator color={c.accent} />
                  <Text style={fs.text}>
                    {file.phase === "loading"
                      ? "正在从 PC 读取文件…"
                      : `正在下载…${file.progress === undefined ? "" : ` ${Math.round(file.progress * 100)}%`}`}
                  </Text>
                </View>
              )}
              {!!file?.message && (
                <Text
                  accessibilityRole={file.phase === "error" ? "alert" : undefined}
                  style={[fs.text, file.phase === "error" && fs.error]}
                >
                  {file.message}
                </Text>
              )}
              {file?.phase === "confirm" && (
                <View style={fs.actions}>
                  <Pressable accessibilityRole="button" onPress={close} style={fs.secondary}>
                    <Text style={fs.text}>取消</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="确认下载"
                    onPress={() => void download()}
                    style={fs.primary}
                  >
                    <Text style={fs.primaryText}>下载文件</Text>
                  </Pressable>
                </View>
              )}
              {file?.phase === "error" && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => open(file.path)}
                  style={fs.secondary}
                >
                  <Text style={fs.text}>重试</Text>
                </Pressable>
              )}
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </FileLinkContext.Provider>
  );
}

const fs = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", padding: 12 },
  reader: {
    width: "100%",
    maxWidth: 960,
    height: "90%",
    alignSelf: "center",
    backgroundColor: c.bg,
    borderRadius: 12,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: c.line,
    gap: 8,
  },
  heading: { flex: 1, minWidth: 0 },
  title: { fontSize: 18, fontWeight: "600", color: c.text },
  meta: { color: c.muted, fontSize: 13, marginTop: 4 },
  icon: { padding: 10 },
  body: { flex: 1 },
  content: { padding: 20, gap: 16 },
  text: { fontSize: 16, lineHeight: 26, color: c.text },
  status: { alignItems: "center", gap: 16, paddingVertical: 40 },
  error: { color: c.danger },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 12 },
  primary: {
    backgroundColor: c.accent,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 6,
  },
  primaryText: { color: "#fff", fontSize: 16 },
  secondary: {
    borderWidth: 1,
    borderColor: c.line,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 6,
    alignSelf: "flex-start",
  },
});
