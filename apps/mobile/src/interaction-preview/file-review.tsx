import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Eye,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  X,
} from "lucide-react-native";
import { codeLanguage, codeRuns } from "../../../../packages/client-shared/src/code-highlighting";
import { useTheme } from "../styles";
import { ChromeButton } from "../interaction/primitives";
import { DrawerSwipeBlock } from "../drawer-swipe-block";
import { exportPreviewText } from "./preview-export";
import { reviewFiles } from "./review-fixtures";
import type { ReviewCondition, ReviewFile } from "./review-fixtures";

export type FileReviewState = {
  tab: "changed" | "all";
  query: string;
  kind: "path" | "content";
  hidden: boolean;
  matchCase: boolean;
  expanded: string[];
  file?: string;
  line?: number;
  mode: "source" | "diff";
  listY: number;
};
export const initialFileReview = (): FileReviewState => ({
  tab: "all",
  query: "",
  kind: "path",
  hidden: false,
  matchCase: false,
  expanded: [],
  mode: "source",
  listY: 0,
});
type CodeLine = { text: string; kind: "same" | "add" | "remove"; old?: number; next?: number };
function changedLines(file: ReviewFile): CodeLine[] {
  const before = (file.before ?? "").trimEnd().split("\n"),
    after = file.content.trimEnd().split("\n");
  const table = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let a = before.length - 1; a >= 0; a--)
    for (let b = after.length - 1; b >= 0; b--)
      table[a]![b] =
        before[a] === after[b]
          ? table[a + 1]![b + 1]! + 1
          : Math.max(table[a + 1]![b]!, table[a]![b + 1]!);
  const lines: CodeLine[] = [];
  let a = 0,
    b = 0;
  while (a < before.length || b < after.length) {
    if (a < before.length && b < after.length && before[a] === after[b]) {
      lines.push({ text: before[a]!, kind: "same", old: ++a, next: ++b });
    } else if (a < before.length && (b === after.length || table[a + 1]![b]! >= table[a]![b + 1]!))
      lines.push({ text: before[a]!, kind: "remove", old: ++a });
    else lines.push({ text: after[b]!, kind: "add", next: ++b });
  }
  return lines;
}
export const reviewChanges = reviewFiles
  .filter((file) => file.before !== undefined)
  .map((file) => {
    const lines = changedLines(file);
    return {
      file,
      lines,
      added: lines.filter((line) => line.kind === "add").length,
      removed: lines.filter((line) => line.kind === "remove").length,
    };
  });

function MatchText({ text, query, enabled }: { text: string; query: string; enabled: boolean }) {
  const { c } = useTheme();
  const index = query
    ? (enabled ? text : text.toLocaleLowerCase()).indexOf(
        enabled ? query : query.toLocaleLowerCase(),
      )
    : -1;
  return (
    <Text>
      {index < 0 ? (
        text
      ) : (
        <>
          {text.slice(0, index)}
          <Text style={{ backgroundColor: c.soft, color: c.accent }}>
            {text.slice(index, index + query.length)}
          </Text>
          {text.slice(index + query.length)}
        </>
      )}
    </Text>
  );
}

export function FileReviewPanel({
  state,
  onChange,
  condition,
  onCopy,
  onNotice,
}: {
  state: FileReviewState;
  onChange: (state: FileReviewState) => void;
  condition: ReviewCondition;
  onCopy: (text: string) => void;
  onNotice: (text: string) => void;
}) {
  const { c } = useTheme();
  const list = useRef<ScrollView>(null),
    code = useRef<ScrollView>(null);
  const [searching, setSearching] = useState(false),
    [retried, setRetried] = useState(false);
  useEffect(() => {
    setRetried(false);
  }, [condition]);
  useEffect(() => {
    if (!state.query) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => setSearching(false), 180);
    return () => clearTimeout(timer);
  }, [state.query, state.kind, state.matchCase]);
  const selected = reviewFiles.find((file) => file.path === state.file);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (selected)
        code.current?.scrollTo({ y: Math.max(0, ((state.line ?? 1) - 4) * 23), animated: false });
      else list.current?.scrollTo({ y: state.listY, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [state.file, state.line]);
  const set = (next: Partial<FileReviewState>) => onChange({ ...state, ...next });
  const files = reviewFiles.filter(
    (file) => (state.hidden || !file.hidden) && (state.tab === "all" || file.before !== undefined),
  );
  const contains = (text: string) =>
    (state.matchCase ? text : text.toLocaleLowerCase()).includes(
      state.matchCase ? state.query : state.query.toLocaleLowerCase(),
    );
  const results = useMemo(
    () =>
      files.flatMap((file) =>
        state.kind === "path"
          ? contains(file.path)
            ? [{ file, line: 0, text: file.path }]
            : []
          : file.content
              .split("\n")
              .flatMap((text, index) => (contains(text) ? [{ file, line: index + 1, text }] : [])),
      ),
    [state.query, state.kind, state.matchCase, state.tab, state.hidden],
  );
  const rows: { path: string; directory: boolean; depth: number; file?: ReviewFile }[] = [];
  const walk = (parent: string, depth: number) => {
    const entries = new Map<string, { directory: boolean; file?: ReviewFile }>();
    for (const file of files)
      if (!parent || file.path.startsWith(parent + "/")) {
        const rest = file.path.slice(parent ? parent.length + 1 : 0),
          name = rest.split("/")[0]!;
        entries.set(name, {
          directory: rest.includes("/"),
          file: rest.includes("/") ? undefined : file,
        });
      }
    for (const [name, entry] of [...entries].sort(
      (a, b) => Number(b[1].directory) - Number(a[1].directory) || a[0].localeCompare(b[0]),
    )) {
      const path = parent ? `${parent}/${name}` : name;
      rows.push({ path, depth, ...entry });
      if (entry.directory && state.expanded.includes(path)) walk(path, depth + 1);
    }
  };
  walk("", 0);
  const open = (file: ReviewFile, line = 0) =>
    set({
      file: file.path,
      line: line || undefined,
      mode: state.tab === "changed" && !line ? "diff" : "source",
    });
  const unavailable = condition === "offline" || (condition === "failure" && !retried);
  const errorBox = (
    <View style={{ padding: 26, alignItems: "center", gap: 15 }}>
      <Folder size={28} color={c.faint} />
      <Text style={{ color: c.text, fontSize: 14 }}>
        {condition === "offline" ? "设备离线，暂时无法读取文件" : "目录加载失败"}
      </Text>
      <Text style={{ color: c.muted, fontSize: 12, textAlign: "center" }}>
        {condition === "offline"
          ? "已打开的内容保留，恢复连接后可继续浏览。"
          : "目录与搜索条件已保留，可以重新加载。"}
      </Text>
      {condition !== "offline" && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="重试加载目录"
          onPress={() => setRetried(true)}
          style={[s.pill, { backgroundColor: c.soft }]}
        >
          <RefreshCw size={14} color={c.accent} />
          <Text style={{ color: c.accent }}>重试</Text>
        </Pressable>
      )}
    </View>
  );
  if (selected) {
    const change = reviewChanges.find((value) => value.file.path === selected.path);
    const lines: CodeLine[] =
      state.mode === "diff" && change
        ? change.lines
        : selected.content
            .trimEnd()
            .split("\n")
            .map((text, index) => ({ text, kind: "same", next: index + 1 }));
    return (
      <View style={{ flex: 1 }}>
        <View style={[s.fileBar, { borderBottomColor: c.line }]}>
          <ChromeButton
            Icon={ArrowLeft}
            label="返回文件列表"
            size={19}
            onPress={() => set({ file: undefined, line: undefined })}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ color: c.text, fontSize: 13, fontWeight: "600" }}>
              {selected.path.split("/").at(-1)}
            </Text>
            <Text numberOfLines={1} style={{ color: c.muted, fontSize: 10, marginTop: 3 }}>
              {selected.path}
              {state.line ? ` · 第 ${state.line} 行` : ""}
            </Text>
          </View>
          <ChromeButton
            Icon={Copy}
            label="复制完整源码"
            size={17}
            onPress={() => onCopy(selected.content)}
          />
          <ChromeButton
            Icon={Download}
            label="下载文件"
            size={17}
            onPress={() =>
              void exportPreviewText(selected.path.split("/").at(-1)!, selected.content).catch(() =>
                onNotice("下载失败，请重试"),
              )
            }
          />
        </View>
        {change && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 10,
              paddingVertical: 8,
              gap: 10,
            }}
          >
            {(["diff", "source"] as const).map((mode) => (
              <Pressable
                accessibilityRole="tab"
                aria-selected={state.mode === mode}
                accessibilityState={{ selected: state.mode === mode }}
                key={mode}
                onPress={() => set({ mode })}
                style={[s.pill, { backgroundColor: state.mode === mode ? c.soft : "transparent" }]}
              >
                <Text style={{ color: state.mode === mode ? c.text : c.muted, fontSize: 12 }}>
                  {mode === "diff" ? "差异" : "源码"}
                </Text>
              </Pressable>
            ))}
            <View style={{ flex: 1 }} />
            <Text style={{ color: c.success, fontSize: 11 }}>+{change.added}</Text>
            <Text style={{ color: c.danger, fontSize: 11 }}>−{change.removed}</Text>
          </View>
        )}
        {unavailable && (
          <Text
            accessibilityRole="alert"
            style={{ padding: 10, color: c.taskRunning, fontSize: 11 }}
          >
            {condition === "offline" ? "设备离线" : "文件刷新失败"}，当前显示已缓存的示例内容。
          </Text>
        )}
        <ScrollView ref={code} style={{ flex: 1, backgroundColor: c.bg }}>
          <DrawerSwipeBlock>
            <ScrollView horizontal contentContainerStyle={{ flexGrow: 1 }}>
              <View style={{ minWidth: "100%", paddingBottom: 30 }}>
                {state.mode === "diff" && change && (
                  <Text
                    style={{
                      color: c.diffHunkText,
                      backgroundColor: c.diffHunkBg,
                      padding: 8,
                      fontSize: 11,
                    }}
                  >
                    @@ −1,{selected.before!.trimEnd().split("\n").length} +1,
                    {selected.content.trimEnd().split("\n").length} @@
                  </Text>
                )}
                {lines.map((line, index) => (
                  <View
                    key={index}
                    testID={line.next === state.line ? "search-target-line" : undefined}
                    style={{
                      flexDirection: "row",
                      minHeight: 23,
                      backgroundColor:
                        line.kind === "add"
                          ? c.diffAddedBg
                          : line.kind === "remove"
                            ? c.diffDeletedBg
                            : line.next === state.line
                              ? c.soft
                              : "transparent",
                      paddingRight: 20,
                    }}
                  >
                    {state.mode === "diff" && (
                      <Text style={[s.lineNumber, { color: c.faint }]}>{line.old ?? ""}</Text>
                    )}
                    <Text style={[s.lineNumber, { color: c.faint }]}>{line.next ?? ""}</Text>
                    {state.mode === "diff" && (
                      <Text
                        style={{
                          width: 18,
                          color: line.kind === "add" ? c.success : c.danger,
                          fontSize: 12,
                          lineHeight: 23,
                        }}
                      >
                        {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}
                      </Text>
                    )}
                    <Text
                      selectable
                      style={{
                        color: c.text,
                        fontFamily:
                          Platform.OS === "web" ? "ui-monospace, Consolas, monospace" : "monospace",
                        fontSize: 11,
                        lineHeight: 23,
                      }}
                    >
                      {codeRuns(line.text || " ", codeLanguage(selected.path)).map((run, n) => (
                        <Text key={n} style={run.tone ? { color: c[run.tone] } : undefined}>
                          {run.text}
                        </Text>
                      ))}
                    </Text>
                  </View>
                ))}
              </View>
            </ScrollView>
          </DrawerSwipeBlock>
        </ScrollView>
        <View style={[s.footer, { borderTopColor: c.line }]}>
          <FileCode2 size={14} color={c.muted} />
          <Text style={{ color: c.muted, fontSize: 10 }}>
            {selected.language.toUpperCase()} · UTF-8 ·{" "}
            {selected.content.trimEnd().split("\n").length} 行
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={{ color: c.faint, fontSize: 10 }}>只读</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      <View style={[s.tabs, { backgroundColor: c.composer }]}>
        {(["changed", "all"] as const).map((tab) => (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityLabel={tab === "all" ? "所有文件" : "已修改"}
            aria-selected={state.tab === tab}
            accessibilityState={{ selected: state.tab === tab }}
            onPress={() => set({ tab, listY: 0 })}
            style={[s.tab, { backgroundColor: state.tab === tab ? c.surface : "transparent" }]}
          >
            <Text style={{ color: c.text, fontSize: 12 }}>
              {tab === "all" ? "所有文件" : `已修改 ${reviewChanges.length}`}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={{ paddingHorizontal: 10, paddingVertical: 7 }}>
        <View style={[s.search, { backgroundColor: c.composer }]}>
          <Search size={15} color={c.muted} />
          <TextInput
            accessibilityLabel="搜索项目文件"
            value={state.query}
            onChangeText={(query) => set({ query, listY: 0 })}
            placeholder={state.kind === "content" ? "搜索文件内容" : "搜索文件名或路径"}
            placeholderTextColor={c.faint}
            style={{ flex: 1, color: c.text, height: 38, fontSize: 13, minWidth: 0 }}
          />
          {!!state.query && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="清空文件搜索"
              onPress={() => set({ query: "" })}
              hitSlop={9}
            >
              <X size={15} color={c.muted} />
            </Pressable>
          )}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 }}>
          {(["path", "content"] as const).map((kind) => (
            <Pressable
              key={kind}
              accessibilityRole="tab"
              accessibilityLabel={kind === "path" ? "按文件名和路径搜索" : "按文件内容搜索"}
              aria-selected={state.kind === kind}
              accessibilityState={{ selected: state.kind === kind }}
              onPress={() => set({ kind })}
              style={[s.pill, { backgroundColor: kind === state.kind ? c.soft : "transparent" }]}
            >
              <Text style={{ color: kind === state.kind ? c.text : c.muted, fontSize: 11 }}>
                {kind === "path" ? "文件名 / 路径" : "内容"}
              </Text>
            </Pressable>
          ))}
          <View style={{ flex: 1 }} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="区分大小写"
            accessibilityState={{ selected: state.matchCase }}
            onPress={() => set({ matchCase: !state.matchCase })}
            style={[s.pill, { backgroundColor: state.matchCase ? c.soft : "transparent" }]}
          >
            <Text style={{ color: c.muted, fontSize: 12 }}>Aa</Text>
          </Pressable>
          <ChromeButton
            Icon={Eye}
            label={state.hidden ? "隐藏隐藏文件" : "显示隐藏文件"}
            size={16}
            selected={state.hidden}
            onPress={() => set({ hidden: !state.hidden })}
          />
        </View>
      </View>
      <View style={[s.breadcrumb, { borderColor: c.line }]}>
        <Folder size={13} color={c.muted} />
        <Text style={{ color: c.muted, flex: 1, fontSize: 11 }}>旅行相册 /</Text>
        <Text style={{ color: c.faint, fontSize: 10 }}>
          {state.hidden ? "含隐藏文件" : "隐藏已忽略项"}
        </Text>
      </View>
      {unavailable ? (
        errorBox
      ) : searching ? (
        <View style={{ padding: 25, flexDirection: "row", justifyContent: "center", gap: 10 }}>
          <ActivityIndicator size="small" color={c.muted} />
          <Text style={{ color: c.muted, fontSize: 12 }}>正在搜索…</Text>
        </View>
      ) : (
        <ScrollView
          ref={list}
          style={{ flex: 1 }}
          onScroll={(event) => {
            const y = event.nativeEvent.contentOffset.y;
            if (Math.abs(y - state.listY) > 2) set({ listY: y });
          }}
          scrollEventThrottle={120}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 30 }}
        >
          {!!state.query ? (
            <>
              <Text style={{ color: c.muted, fontSize: 11, padding: 12 }}>
                {results.length ? `${results.length} 处匹配` : "没有匹配结果"}
              </Text>
              {results.map((result, index) => (
                <Pressable
                  key={`${result.file.path}:${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={`打开 ${result.file.path}${result.line ? ` 第 ${result.line} 行` : ""}`}
                  onPress={() => open(result.file, result.line)}
                  style={[s.result, { borderBottomColor: c.line }]}
                >
                  <View style={{ flexDirection: "row", gap: 7, alignItems: "center" }}>
                    <FileText size={14} color={c.muted} />
                    <Text numberOfLines={1} style={{ color: c.text, fontSize: 12, flex: 1 }}>
                      <MatchText
                        text={result.file.path}
                        query={state.kind === "path" ? state.query : ""}
                        enabled={state.matchCase}
                      />
                    </Text>
                    {!!result.line && (
                      <Text style={{ color: c.faint, fontSize: 10 }}>L{result.line}</Text>
                    )}
                  </View>
                  {!!result.line && (
                    <Text
                      numberOfLines={2}
                      style={{
                        color: c.muted,
                        fontSize: 11,
                        lineHeight: 19,
                        paddingLeft: 21,
                        marginTop: 5,
                      }}
                    >
                      <MatchText
                        text={result.text.trim()}
                        query={state.query}
                        enabled={state.matchCase}
                      />
                    </Text>
                  )}
                </Pressable>
              ))}
            </>
          ) : state.tab === "changed" ? (
            <>
              <Text style={{ color: c.faint, fontSize: 10, padding: 12 }}>
                当前轮次观测到的修改
              </Text>
              {reviewChanges.map((change) => (
                <Pressable
                  key={change.file.path}
                  accessibilityRole="button"
                  accessibilityLabel={`查看差异 ${change.file.path}`}
                  onPress={() => open(change.file)}
                  style={[s.fileRow, { borderBottomColor: c.line }]}
                >
                  <FileCode2 size={15} color={c.muted} />
                  <Text style={{ color: c.text, flex: 1, fontSize: 12 }}>{change.file.path}</Text>
                  <Text style={{ color: c.success, fontSize: 11 }}>+{change.added}</Text>
                  <Text style={{ color: c.danger, fontSize: 11 }}>−{change.removed}</Text>
                  <ChevronRight size={14} color={c.faint} />
                </Pressable>
              ))}
            </>
          ) : (
            rows.map((row) => {
              const expanded = state.expanded.includes(row.path),
                Icon = row.directory ? (expanded ? FolderOpen : Folder) : FileText;
              return (
                <Pressable
                  key={row.path}
                  accessibilityRole="button"
                  accessibilityLabel={`${row.directory ? (expanded ? "收起目录" : "展开目录") : "打开文件"} ${row.path}`}
                  aria-expanded={row.directory ? expanded : undefined}
                  accessibilityState={row.directory ? { expanded } : undefined}
                  onPress={() =>
                    row.directory
                      ? set({
                          expanded: expanded
                            ? state.expanded.filter((path) => path !== row.path)
                            : [...state.expanded, row.path],
                        })
                      : open(row.file!)
                  }
                  style={[
                    s.fileRow,
                    { paddingLeft: 10 + row.depth * 18, borderBottomColor: c.line },
                  ]}
                >
                  {row.directory ? (
                    expanded ? (
                      <ChevronDown size={12} color={c.muted} />
                    ) : (
                      <ChevronRight size={12} color={c.muted} />
                    )
                  ) : (
                    <View style={{ width: 12 }} />
                  )}
                  <Icon size={15} color={c.muted} />
                  <Text style={{ color: c.text, fontSize: 12, flex: 1 }}>
                    {row.path.split("/").at(-1)}
                  </Text>
                </Pressable>
              );
            })
          )}
        </ScrollView>
      )}
      <View style={[s.footer, { borderTopColor: c.line }]}>
        <FolderOpen size={13} color={c.muted} />
        <Text numberOfLines={1} style={{ color: c.faint, fontSize: 10, flex: 1 }}>
          F:\\projects\\travel-album
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="复制项目目录"
          onPress={() => onCopy("F:\\projects\\travel-album")}
          hitSlop={8}
        >
          <Copy size={14} color={c.muted} />
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  tabs: {
    flexDirection: "row",
    borderRadius: 8,
    marginHorizontal: 10,
    padding: 2,
    marginBottom: 6,
  },
  tab: { flex: 1, height: 29, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  search: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    gap: 8,
    borderRadius: 10,
  },
  pill: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderRadius: 9,
    paddingHorizontal: 10,
  },
  breadcrumb: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 13,
    height: 32,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: 44,
    paddingHorizontal: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  result: {
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fileBar: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  lineNumber: {
    width: 32,
    fontSize: 10,
    lineHeight: 23,
    textAlign: "right",
    paddingRight: 8,
    fontFamily: Platform.OS === "web" ? "ui-monospace, Consolas, monospace" : "monospace",
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 13,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
