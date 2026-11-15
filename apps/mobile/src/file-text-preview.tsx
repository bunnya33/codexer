import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { fileReaderKind } from '../../../packages/client-shared/src/file-links';
import { FileLinkContext } from './file-link-context';
import { Markdown } from './markdown';
import { SourceCode } from './source-code';
import type { SourceCodeProps } from './source-code';
import { useTheme } from './styles';

/** Shared by conversation citations and project files; no script execution. */
export function FileTextPreview(props: SourceCodeProps) {
  return <TextPreview key={props.path} {...props} />;
}

function TextPreview(props: SourceCodeProps) {
  const { c } = useTheme();
  const markdown = fileReaderKind(props.path) === 'markdown';
  const [mode, setMode] = useState<'preview' | 'source'>(props.highlightLine ? 'source' : 'preview');
  return <FileLinkContext.Provider value={undefined}>
    <View style={{ flex: 1, minHeight: 0 }}>
      {markdown && <View style={{ flexDirection: 'row', paddingHorizontal: 12, borderBottomWidth: .5, borderColor: c.line }}>
        {(['preview', 'source'] as const).map(tab => <Pressable key={tab} accessibilityRole="tab" accessibilityLabel={tab === 'preview' ? '文档预览' : '源码与搜索'} accessibilityState={{ selected: mode === tab }} onPress={() => setMode(tab)} style={{ padding: 12, borderBottomWidth: 2, borderBottomColor: mode === tab ? c.accent : 'transparent' }}><Text style={{ fontSize: 13, color: mode === tab ? c.accent : c.muted }}>{tab === 'preview' ? '文档预览' : '源码与搜索'}</Text></Pressable>)}
      </View>}
      {markdown && mode === 'preview'
        ? <ScrollView contentContainerStyle={{ padding: 20 }}><Markdown>{props.text}</Markdown></ScrollView>
        : <SourceCode {...props} />}
    </View>
  </FileLinkContext.Provider>;
}
