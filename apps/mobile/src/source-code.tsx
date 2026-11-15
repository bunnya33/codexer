import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { CaseSensitive, ChevronDown, ChevronUp, Search, X } from 'lucide-react-native';
import { codeLanguage, codeRuns } from '../../../packages/client-shared/src/code-highlighting';
import type { CodeRun } from '../../../packages/client-shared/src/code-highlighting';
import { markSearchRuns, searchSource } from '../../../packages/client-shared/src/source-search';
import type { SourceMatch } from '../../../packages/client-shared/src/source-search';
import { useTheme } from './styles';
import { ChromeButton } from './interaction/primitives';

export type SourceCodeProps = { text: string; path: string; initialOffset?: number; onOffset?: (offset: number) => void; highlightLine?: number };
type SourceRow = { text: string; runs?: CodeRun[] };
const lineHeight = 23;
const fontFamily = Platform.select({ ios: 'Menlo', macos: 'Menlo', windows: 'Consolas', default: 'monospace' });

export function SourceCode(props: SourceCodeProps) {
  return <SourceReader key={props.path} {...props} />;
}

function SourceReader({ text, path, initialOffset = 0, onOffset, highlightLine }: SourceCodeProps) {
  const { c } = useTheme();
  const [query, setQuery] = useState(''), [matchCase, setMatchCase] = useState(false), [index, setIndex] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const list = useRef<FlatList<SourceRow>>(null), horizontal = useRef<ScrollView>(null);
  const language = codeLanguage(path);
  const lines = useMemo(() => text.split(/\r\n|\r|\n/), [text]);
  const rows = useMemo(() => {
    // Highlight short documents together to preserve multiline strings/comments.
    // Large files are highlighted only as rows become visible, keeping scrolling virtualized.
    if (text.length > 128 * 1024) return lines.map(line => ({ text: line }));
    const result: SourceRow[] = lines.map(line => ({ text: line, runs: [] }));
    let line = 0;
    for (const run of codeRuns(lines.join('\n'), language)) {
      run.text.split('\n').forEach((part, i) => {
        if (i) line++;
        if (part) result[line]!.runs!.push({ ...run, text: part });
      });
    }
    return result;
  }, [text, lines, language]);
  const result = useMemo(() => searchSource(lines, deferredQuery, matchCase), [lines, deferredQuery, matchCase]);
  const matchesByLine = useMemo(() => {
    const grouped = new Map<number, SourceMatch[]>();
    for (const match of result.matches) {
      if (!grouped.has(match.line)) grouped.set(match.line, []);
      grouped.get(match.line)!.push(match);
    }
    return grouped;
  }, [result]);
  const currentIndex = Math.min(index, Math.max(0, result.matches.length - 1));
  const active = result.matches[currentIndex];
  const searching = deferredQuery !== query;
  const reveal = useCallback((match: SourceMatch) => {
    list.current?.scrollToOffset({ offset: Math.max(0, match.line - 3) * lineHeight, animated: false });
    horizontal.current?.scrollTo({ x: Math.max(0, match.start - 8) * 8, animated: false });
  }, []);
  useEffect(() => {
    if (!active || searching) return;
    reveal(active);
  }, [active, searching, reveal]);
  const move = (direction: number) => {
    if (!result.matches.length || searching) return;
    const next = (currentIndex + direction + result.matches.length) % result.matches.length;
    setIndex(next);
    // A single hit still needs to be revealed again after the reader scrolls away.
    if (next === currentIndex) reveal(result.matches[next]!);
  };
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: c.code }}>
    <View style={{ paddingHorizontal: 12, paddingBottom: 8, borderBottomWidth: .5, borderBottomColor: c.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 12, color: c.muted }}>{language === 'text' ? '纯文本' : language} · {lines.length} 行</Text>
        {!!query && <Text accessibilityLabel="搜索结果" accessibilityLiveRegion="polite" style={{ fontSize: 12, color: c.muted }}>{searching ? '搜索中…' : `${active ? currentIndex + 1 : 0}/${result.matches.length}${result.limited ? '+' : ''}`}</Text>}
        <ChromeButton Icon={CaseSensitive} label="区分大小写" selected={matchCase} onPress={() => { setMatchCase(value => !value); setIndex(0); }} size={18} />
        <ChromeButton Icon={ChevronUp} label="上一个匹配" disabled={!active || searching} onPress={() => move(-1)} size={18} />
        <ChromeButton Icon={ChevronDown} label="下一个匹配" disabled={!active || searching} onPress={() => move(1)} size={18} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 12, borderRadius: 10, backgroundColor: c.composer, borderWidth: .5, borderColor: c.line }}>
        <Search size={16} color={c.muted} />
        <TextInput accessibilityLabel="搜索文件内容" placeholder="搜索文件内容" placeholderTextColor={c.muted} value={query} onChangeText={value => { setQuery(value); setIndex(0); }} autoCapitalize="none" autoCorrect={false} spellCheck={false} returnKeyType="search" onSubmitEditing={() => move(1)} blurOnSubmit={false} style={{ flex: 1, minWidth: 0, paddingHorizontal: 10, paddingVertical: 10, fontSize: 14, color: c.text }} />
        {!!query && <ChromeButton Icon={X} label="清除文件搜索" onPress={() => { setQuery(''); setIndex(0); }} size={16} />}
      </View>
      {!!query && !searching && !active && <Text accessibilityLiveRegion="polite" style={{ color: c.muted, fontSize: 12, paddingTop: 8 }}>未找到匹配内容</Text>}
      {result.limited && <Text style={{ color: c.muted, fontSize: 12, paddingTop: 8 }}>仅定位前 10,000 处匹配，请输入更完整的关键词。</Text>}
    </View>
    <ScrollView ref={horizontal} horizontal nestedScrollEnabled style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} accessibilityLabel={`${path} 源码`} keyboardShouldPersistTaps="handled">
      <FlatList ref={list} testID="source-lines" key={path} data={rows} extraData={active} style={{ flex: 1, minWidth: '100%' }} initialNumToRender={40} windowSize={9}
        initialScrollIndex={initialOffset > 0 ? Math.min(rows.length - 1, Math.floor(initialOffset / lineHeight)) : undefined}
        onScroll={event => onOffset?.(event.nativeEvent.contentOffset.y)} scrollEventThrottle={64} keyboardShouldPersistTaps="handled"
        getItemLayout={(_data, index) => ({ length: lineHeight, offset: lineHeight * index, index })} keyExtractor={(_row, index) => String(index)}
        renderItem={({ item, index: rowIndex }) => <CodeRow row={item} index={rowIndex} language={language} matches={matchesByLine.get(rowIndex)} active={active?.line === rowIndex ? active : undefined} highlighted={rowIndex + 1 === highlightLine} />} />
    </ScrollView>
  </View>;
}

const CodeRow = memo(function CodeRow({ row, index, language, matches = [], active, highlighted }: { row: SourceRow; index: number; language: string; matches?: SourceMatch[]; active?: SourceMatch; highlighted: boolean }) {
  const { c } = useTheme();
  const runs = useMemo(() => row.runs ?? codeRuns(row.text, language), [row, language]);
  const marked = useMemo(() => markSearchRuns(runs, matches, active), [runs, matches, active]);
  return <View testID={active ? 'active-source-line' : undefined} style={{ flexDirection: 'row', height: lineHeight, paddingRight: 20, backgroundColor: active || highlighted ? c.soft : undefined }}>
    <Text selectable={false} style={{ width: 55, textAlign: 'right', paddingRight: 12, color: active ? c.accent : c.faint, fontFamily, fontSize: 12, lineHeight }}>{index + 1}</Text>
    <Text selectable style={{ color: c.text, fontFamily, fontSize: 12, lineHeight, flexShrink: 0 }}>{marked.length ? marked.map((run, i) => <Text key={i} testID={run.active ? 'active-source-match' : run.match ? 'source-match' : undefined} style={{ color: run.active ? c.onAccent : run.tone ? c[run.tone] : c.text, backgroundColor: run.active ? c.accent : run.match ? c.soft : undefined }}>{run.text}</Text>) : '\u00a0'}</Text>
  </View>;
});
