import { useMemo } from 'react';
import { FlatList, Platform, ScrollView, Text, View } from 'react-native';
import { codeLanguage, codeRuns } from '../../../packages/client-shared/src/code-highlighting';
import type { CodeRun } from '../../../packages/client-shared/src/code-highlighting';
import { useTheme } from './styles';

export function SourceCode({ text, path, initialOffset = 0, onOffset, highlightLine }: { text: string; path: string; initialOffset?: number; onOffset?: (offset: number) => void; highlightLine?: number }) {
  const { c } = useTheme();
  const rows = useMemo(() => {
    const lines: CodeRun[][] = [[]];
    for (const run of codeRuns(text, codeLanguage(path))) {
      run.text.split('\n').forEach((part, index) => { if (index) lines.push([]); if (part) lines.at(-1)!.push({ ...run, text: part }); });
    }
    return lines;
  }, [text, path]);
  const fontFamily = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
  return <ScrollView horizontal nestedScrollEnabled style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} accessibilityLabel={`${path} 源码`}>
    <FlatList key={path} data={rows} style={{ flex: 1, minWidth: '100%' }} initialNumToRender={40} windowSize={9} initialScrollIndex={initialOffset > 0 ? Math.min(rows.length - 1, Math.floor(initialOffset / 23)) : undefined} onScroll={event => onOffset?.(event.nativeEvent.contentOffset.y)} scrollEventThrottle={64} getItemLayout={(_data, index) => ({ length: 23, offset: 23 * index, index })} keyExtractor={(_row, index) => String(index)} renderItem={({ item, index }) => <View style={{ flexDirection: 'row', height: 23, paddingRight: 20, backgroundColor: index+1===highlightLine?c.soft:undefined }}><Text selectable={false} style={{ width: 55, textAlign: 'right', paddingRight: 12, color: c.faint, fontFamily, fontSize: 12, lineHeight: 23 }}>{index + 1}</Text><Text selectable style={{ color: c.text, fontFamily, fontSize: 12, lineHeight: 23 }}>{item.length ? item.map((run, i) => <Text key={i} style={run.tone ? { color: c[run.tone] } : undefined}>{run.text}</Text>) : '\u00a0'}</Text></View>} />
  </ScrollView>;
}
