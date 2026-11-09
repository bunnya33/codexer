import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileCode2,
  Folder,
  RefreshCw,
  Search,
  X,
} from "lucide-react-native";
import type { DeviceCatalog } from "../../../packages/protocol/src/index";
import type { ProjectPage, ProjectQuery } from "../../../packages/protocol/src/project-files";
import type { FileInfo } from "../../../packages/protocol/src/files";
import { MAX_FILE_PREVIEW_BYTES } from "../../../packages/protocol/src/files";
import { ReviewReader } from "./review-reader";
import { SourceCode } from "./source-code";
import { ChromeButton } from "./interaction/primitives";
import { useTheme } from "./styles";
import { relay } from "./relay";
import { copyText } from "./runtime";
import { fileError, previewFile } from "./file-transfer";
import { downloadFile } from "./file-download";

type Entry = NonNullable<ProjectPage["entries"]>[number];
type Listing = {
  entries: Entry[];
  cursor?: string | null;
  limited?: boolean;
  loading?: boolean;
  error?: string;
};
export function ProjectBrowser({
  open,
  onClose,
  deviceId,
  project,
  online,
  supported,
}: {
  open: boolean;
  onClose: () => void;
  deviceId: string;
  project: DeviceCatalog["projects"][number];
  online: boolean;
  supported: boolean;
}) {
  const { c } = useTheme();
  const [root, setRoot] = useState(0),
    [directory, setDirectory] = useState(""),
    [expanded, setExpanded] = useState(new Set<string>()),
    [listings, setListings] = useState<Record<string, Listing>>({});
  const [query, setQuery] = useState(""),
    [mode, setMode] = useState<"path" | "content">("path"),
    [hidden, setHidden] = useState(false),
    [matchCase, setMatchCase] = useState(false);
  const [results, setResults] = useState<ProjectPage>(),
    [searching, setSearching] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<{ path: string; line: number }>(),
    [info, setInfo] = useState<FileInfo>(),
    [text, setText] = useState<string>(),
    [loadingFile, setLoadingFile] = useState(false),
    [feedback, setFeedback] = useState(""),
    [downloading, setDownloading] = useState(false),
    [fileRevision, setFileRevision] = useState(0),
    [resultLimited, setResultLimited] = useState(false);
  const operations = useRef(new Map<string, AbortController>()),
    version = useRef(0),
    downloadLock = useRef(false),
    positions = useRef(new Map<string, { version: string; offset: number }>()),
    listOffset = useRef(0),
    list = useRef<FlatList>(null);
  const cancel = () => {
    version.current++;
    for (const controller of operations.current.values()) controller.abort();
    operations.current.clear();
  };
  const begin = (key: string) => {
    operations.current.get(key)?.abort();
    const controller = new AbortController();
    operations.current.set(key, controller);
    return controller;
  };
  const ready = open && online && supported;
  const listDirectory = async (path: string, cursor?: string | null) => {
    const controller = begin("list:" + path),
      generation = version.current;
    setListings((old) => ({
      ...old,
      [path]: { ...old[path], entries: old[path]?.entries ?? [], loading: true, error: undefined },
    }));
    try {
      const page = await relay.projectFiles(
        deviceId,
        project.id,
        { operation: "list", rootIndex: root, path, hidden, cursor },
        controller.signal,
      );
      if (controller.signal.aborted || generation !== version.current) return;
      setListings((old) => ({
        ...old,
        [path]: {
          entries: cursor
            ? [...(old[path]?.entries ?? []), ...(page.entries ?? [])]
            : (page.entries ?? []),
          cursor: page.nextCursor,
          limited: page.limited,
        },
      }));
    } catch (failure) {
      if (!controller.signal.aborted && generation === version.current)
        setListings((old) => ({
          ...old,
          [path]: { entries: old[path]?.entries ?? [], error: fileError(failure) },
        }));
    } finally {
      if (operations.current.get("list:" + path) === controller)
        operations.current.delete("list:" + path);
    }
  };
  const search = async (cursor?: string | null) => {
    const controller = begin("search"),
      generation = version.current;
    setSearching(true);
    setError("");
    try {
      const page = await relay.projectFiles(
        deviceId,
        project.id,
        {
          operation: "search",
          rootIndex: root,
          path: directory,
          hidden,
          query: query.trim(),
          mode,
          caseSensitive: matchCase,
          cursor,
        },
        controller.signal,
      );
      if (!controller.signal.aborted && generation === version.current)
        setResults((old) => {
          const matches = cursor
            ? [...(old?.matches ?? []), ...(page.matches ?? [])]
            : (page.matches ?? []);
          const capped = matches.length >= 2000;
          setResultLimited(capped);
          return {
            ...page,
            matches: matches.slice(0, 2000),
            nextCursor: capped ? null : page.nextCursor,
          };
        });
    } catch (failure) {
      if (!controller.signal.aborted) setError(fileError(failure));
    } finally {
      if (operations.current.get("search") === controller) {
        operations.current.delete("search");
        setSearching(false);
      }
    }
  };
  useEffect(() => {
    cancel();
    setListings({});
    setResults(undefined);
    setExpanded(new Set());
    setSelected(undefined);
    setInfo(undefined);
    setText(undefined);
    setError("");
    listOffset.current = 0;
  }, [root, directory, hidden, project.roots.join("\0")]);
  useEffect(() => {
    if (!ready) {
      cancel();
      setSearching(false);
      setLoadingFile(false);
      return;
    }
    if (!query.trim()) {
      void listDirectory(directory);
      for (const path of expanded) void listDirectory(path);
    }
    return cancel;
  }, [ready, root, directory, hidden, project.roots.join("\0"), revision, !!query.trim()]);
  useEffect(() => {
    operations.current.get("search")?.abort();
    setResults(undefined);
    setResultLimited(false);
    setError("");
    setSearching(false);
    if (!ready || !query.trim()) return;
    const timer = setTimeout(() => void search(), 250);
    return () => {
      clearTimeout(timer);
      operations.current.get("search")?.abort();
    };
  }, [ready, query, mode, matchCase, root, directory, hidden, revision]);
  useEffect(() => {
    if (!ready || !selected) return;
    const controller = begin("file"),
      generation = version.current;
    setInfo(undefined);
    setText(undefined);
    setFeedback("");
    setLoadingFile(true);
    void (async () => {
      try {
        const page = await relay.projectFiles(
          deviceId,
          project.id,
          { operation: "file", rootIndex: root, path: selected.path },
          controller.signal,
        );
        if (controller.signal.aborted || generation !== version.current) return;
        if (!page.file) throw new Error("file-unavailable");
        setInfo(page.file);
        if (page.file.size > MAX_FILE_PREVIEW_BYTES) {
          setFeedback("超过 2 MiB 预览上限，请下载原文件。");
          return;
        }
        if (/\.(png|jpe?g|webp|gif)$/i.test(selected.path)) return;
        const value = await previewFile(
          relay.projectFileSource(deviceId, project.id, root, selected.path, page.file.version),
          page.file,
          controller.signal,
          false,
        );
        if (!controller.signal.aborted && generation === version.current) setText(value);
      } catch (failure) {
        if (!controller.signal.aborted) setFeedback(fileError(failure));
      } finally {
        if (!controller.signal.aborted) setLoadingFile(false);
      }
    })();
    return () => controller.abort();
  }, [ready, selected?.path, root, fileRevision, !!query.trim()]);
  useEffect(() => {
    if (!selected && open) {
      const frame = requestAnimationFrame(() =>
        list.current?.scrollToOffset({ offset: listOffset.current, animated: false }),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [selected, open]);
  const close = () => {
    cancel();
    onClose();
  };
  const back = () => {
    operations.current.get("file")?.abort();
    setSelected(undefined);
    setInfo(undefined);
    setText(undefined);
    setFeedback("");
  };
  const action = async (task: () => Promise<unknown>, message: string) => {
    try {
      await task();
      setFeedback(message);
    } catch (failure) {
      setFeedback(fileError(failure));
    }
  };
  const download = async () => {
    if (!selected || !info || downloadLock.current) return;
    downloadLock.current = true;
    setDownloading(true);
    const controller = begin("download");
    try {
      await downloadFile(
        relay.projectFileSource(deviceId, project.id, root, selected.path, info.version),
        info,
        controller.signal,
        () => {},
      );
      if (!controller.signal.aborted) setFeedback("已交给系统保存或分享");
    } catch (failure) {
      if (!controller.signal.aborted) setFeedback(fileError(failure));
    } finally {
      downloadLock.current = false;
      setDownloading(false);
    }
  };
  const button = (label: string, onPress: () => void, disabled = false) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={(event) => {
        event.stopPropagation();
        onPress();
      }}
      style={{ padding: 10, opacity: disabled ? 0.4 : 1 }}
    >
      <Text style={{ color: c.accent, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
  const rows: Array<{
    key: string;
    entry?: Entry;
    path?: string;
    depth: number;
    more?: boolean;
    error?: string;
    loading?: boolean;
  }> = [];
  const append = (path: string, depth: number) => {
    const data = listings[path];
    if (!data) return;
    for (const entry of data.entries) {
      rows.push({ key: entry.path, entry, depth });
      if (entry.kind === "directory" && expanded.has(entry.path)) append(entry.path, depth + 1);
    }
    if (data.cursor || data.error || data.loading || !data.entries.length)
      rows.push({
        key: path + ":state",
        path,
        depth,
        more: !!data.cursor,
        error: data.error,
        loading: data.loading,
      });
  };
  if (!query.trim()) append(directory, 0);
  const source =
    selected && info
      ? relay.projectFileSource(deviceId, project.id, root, selected.path, info.version)
      : undefined;
  return (
    <ReviewReader
      open={open}
      onClose={close}
      onBack={selected ? back : undefined}
      title={selected ? "文件" : "项目文件"}
    >
      <View style={{ padding: 16, gap: 10 }}>
        <Text style={{ fontSize: 12, color: c.muted }}>
          {project.name} · {project.roots[root] ?? "目录已移除"}
        </Text>
        {selected ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text selectable style={{ color: c.text, fontSize: 13, flex: 1 }}>
              {selected.path}
            </Text>
            <ChromeButton
              Icon={Copy}
              label="复制文件内容"
              disabled={text === undefined}
              onPress={() => void action(() => copyText(text ?? ""), "已复制")}
              size={18}
            />
            <ChromeButton
              Icon={Download}
              label="下载项目文件"
              disabled={!info || downloading}
              onPress={() => void download()}
              size={18}
            />
          </View>
        ) : (
          <>
            {project.roots.length > 1 && (
              <ScrollView horizontal>
                {project.roots.map((path, index) =>
                  button(`${index === root ? "✓ " : ""}${path}`, () => {
                    setRoot(index);
                    setDirectory("");
                    setQuery("");
                  }),
                )}
              </ScrollView>
            )}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              {button("项目根目录", () => {
                setDirectory("");
                setQuery("");
              })}
              {directory
                .split("/")
                .filter(Boolean)
                .map((part, index) =>
                  button(part, () => {
                    setDirectory(
                      directory
                        .split("/")
                        .slice(0, index + 1)
                        .join("/"),
                    );
                    setQuery("");
                  }),
                )}
              <View style={{ flex: 1 }} />
              <ChromeButton
                Icon={RefreshCw}
                label="刷新项目文件"
                onPress={() => setRevision((v) => v + 1)}
                size={18}
              />
            </View>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                borderRadius: 16,
                backgroundColor: c.composer,
                paddingHorizontal: 12,
              }}
            >
              <Search size={17} color={c.muted} />
              <TextInput
                accessibilityLabel="搜索项目文件"
                value={query}
                onChangeText={setQuery}
                placeholder={mode === "content" ? "搜索文件内容" : "搜索文件名或路径"}
                placeholderTextColor={c.muted}
                style={{ flex: 1, color: c.text, minHeight: 44, fontSize: 14 }}
              />
              {!!query && (
                <ChromeButton
                  Icon={X}
                  label="清空文件搜索"
                  onPress={() => setQuery("")}
                  size={15}
                />
              )}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
              {(["path", "content"] as const).map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: mode === value }}
                  onPress={() => setMode(value)}
                  style={{
                    padding: 9,
                    borderRadius: 12,
                    backgroundColor: mode === value ? c.composer : "transparent",
                  }}
                >
                  <Text style={{ color: c.text, fontSize: 13 }}>
                    {value === "path" ? "文件名 / 路径" : "文件内容"}
                  </Text>
                </Pressable>
              ))}
              <Text style={{ fontSize: 11, color: c.muted }}>区分大小写</Text>
              <Switch
                accessibilityLabel="文件搜索区分大小写"
                value={matchCase}
                onValueChange={setMatchCase}
              />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Switch
                accessibilityLabel="显示隐藏和常见忽略目录"
                value={hidden}
                onValueChange={setHidden}
              />
              <Text style={{ fontSize: 11, color: c.muted, flex: 1 }}>
                {hidden
                  ? "包括隐藏和常见忽略目录；目录外链接不可读取"
                  : "隐藏点文件、.git、依赖及常见构建缓存"}
              </Text>
            </View>
          </>
        )}
        {!!feedback && (
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: c.muted, fontSize: 12, lineHeight: 20 }}
          >
            {feedback}
          </Text>
        )}
        {!online ? (
          <Text style={{ color: c.muted }}>设备离线，连接后可继续浏览。</Text>
        ) : !supported ? (
          <Text style={{ color: c.muted }}>请更新服务器和 Codexer Agent 以启用项目浏览。</Text>
        ) : null}
      </View>
      {ready &&
        (selected ? (
          <View style={{ flex: 1 }}>
            {loadingFile ? (
              <ActivityIndicator color={c.muted} />
            ) : text !== undefined ? (
              <SourceCode
                key={selected.path + info?.version}
                path={selected.path}
                text={text}
                highlightLine={selected.line || undefined}
                initialOffset={
                  positions.current.get(selected.path)?.version === info?.version
                    ? positions.current.get(selected.path)!.offset
                    : Math.max(0, selected.line - 5) * 23
                }
                onOffset={(offset) =>
                  info && positions.current.set(selected.path, { version: info.version, offset })
                }
              />
            ) : source && /\.(png|jpe?g|webp|gif)$/i.test(selected.path) ? (
              <Image
                source={source}
                resizeMode="contain"
                style={{ flex: 1, minHeight: 200 }}
                accessibilityLabel={selected.path}
              />
            ) : !info ? (
              button("重新读取文件", () => setFileRevision((v) => v + 1))
            ) : null}
          </View>
        ) : query.trim() ? (
          <FlatList
            data={results?.matches ?? []}
            keyExtractor={(item, index) => `${item.path}:${item.line}:${index}`}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`打开 ${item.path}${item.line ? ` 第 ${item.line} 行` : ""}`}
                onPress={() => setSelected({ path: item.path, line: item.line })}
                style={{ padding: 16, borderBottomWidth: 0.5, borderColor: c.line, gap: 6 }}
              >
                <Text style={{ fontSize: 13, color: c.text }}>
                  {item.path}
                  {item.line ? ` : ${item.line}` : ""}
                </Text>
                {!!item.line && (
                  <Text numberOfLines={2} style={{ fontSize: 12, color: c.muted }}>
                    {item.text}
                  </Text>
                )}
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={{ padding: 20, color: c.muted }}>
                {searching ? "正在搜索…" : error || "没有匹配结果"}
              </Text>
            }
            ListFooterComponent={
              <View style={{ padding: 16, gap: 6 }}>
                {searching ? (
                  <>
                    <ActivityIndicator color={c.muted} />
                    {button("停止搜索", () => {
                      operations.current.get("search")?.abort();
                      setSearching(false);
                    })}
                  </>
                ) : results?.nextCursor ? (
                  button("继续搜索", () => void search(results.nextCursor))
                ) : null}
                {!!results && (
                  <Text style={{ color: c.muted, fontSize: 11 }}>
                    已扫描 {results.scanned ?? 0} 个文件 · 跳过 {results.skipped ?? 0}{" "}
                    个二进制、大文件、链接或不可读项目
                    {results.nextCursor ? " · 尚有结果未搜索" : ""}
                  </Text>
                )}
                {resultLimited && (
                  <Text style={{ color: c.muted, fontSize: 12 }}>
                    仅显示前 2,000 条匹配，请缩小搜索范围。
                  </Text>
                )}
                {!!error && <Text style={{ color: c.danger }}>{error}</Text>}
              </View>
            }
          />
        ) : (
          <FlatList
            ref={list}
            data={rows}
            keyExtractor={(row) => row.key}
            onScroll={(event) => {
              listOffset.current = event.nativeEvent.contentOffset.y;
            }}
            scrollEventThrottle={64}
            renderItem={({ item }) =>
              item.entry ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={item.entry.link}
                  accessibilityLabel={`${item.entry.kind === "directory" ? "展开目录" : "打开文件"} ${item.entry.path}`}
                  onPress={() => {
                    const entry = item.entry!;
                    if (entry.kind === "directory") {
                      const next = new Set(expanded);
                      if (next.has(entry.path)) next.delete(entry.path);
                      else {
                        next.add(entry.path);
                        if (!listings[entry.path]) void listDirectory(entry.path);
                      }
                      setExpanded(next);
                    } else setSelected({ path: entry.path, line: 0 });
                  }}
                  style={{
                    paddingLeft: 16 + item.depth * 16,
                    paddingRight: 16,
                    minHeight: 48,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    borderBottomWidth: 0.5,
                    borderColor: c.line,
                    opacity: item.entry.link ? 0.45 : 1,
                  }}
                >
                  {item.entry.kind === "directory" ? (
                    <>
                      <ChevronRight
                        size={14}
                        color={c.muted}
                        style={{
                          transform: [{ rotate: expanded.has(item.entry.path) ? "90deg" : "0deg" }],
                        }}
                      />
                      <Folder size={17} color={c.muted} />
                    </>
                  ) : (
                    <FileCode2 size={17} color={c.muted} />
                  )}
                  <Text style={{ color: c.text, fontSize: 13, flex: 1 }}>
                    {item.entry.name}
                    {item.entry.link ? " · 链接不可读取" : ""}
                  </Text>
                  {item.entry.kind === "directory" &&
                    button("进入", () => setDirectory(item.entry!.path))}
                </Pressable>
              ) : (
                <View style={{ paddingLeft: 16 + item.depth * 16, paddingVertical: 12 }}>
                  {item.loading ? (
                    <ActivityIndicator color={c.muted} />
                  ) : item.error ? (
                    <>
                      <Text style={{ color: c.danger, fontSize: 12 }}>{item.error}</Text>
                      {button("重试目录", () => void listDirectory(item.path!))}
                    </>
                  ) : item.more ? (
                    button(
                      "加载更多文件",
                      () => void listDirectory(item.path!, listings[item.path!]?.cursor),
                    )
                  ) : (
                    <Text style={{ color: c.muted, fontSize: 12 }}>空目录</Text>
                  )}
                </View>
              )
            }
            ListFooterComponent={
              listings[directory]?.limited ? (
                <Text style={{ color: c.muted, padding: 16, fontSize: 12 }}>
                  该目录超过 10,000 项，仅显示前 10,000 项。请进入子目录缩小范围。
                </Text>
              ) : null
            }
          />
        ))}
    </ReviewReader>
  );
}
