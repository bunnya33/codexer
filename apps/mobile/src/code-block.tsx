import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Check, Copy } from 'lucide-react-native';
import { copyText } from './runtime';
import { useTheme } from './styles';
import { DrawerSwipeBlock } from './drawer-swipe-block';
import { codeRuns } from '../../../packages/client-shared/src/code-highlighting';
import { NativeMessageText } from './message-native';
import { ReplyTextBlock } from './message-selection';

export function CodeBlock({ children, language = 'text', replySelection }: { children: string; language?: string; replySelection?: { onSelection?: (active: boolean) => void; onCopied?: () => void } }) {
  const { c, s } = useTheme();
  const [copied, setCopied] = useState(false);
  const runs = useMemo(() => codeRuns(children, language), [children, language]);
  return <View style={s.tool}><View style={s.toolHead}><Text style={[s.toolPreview, { flex: 1 }]}>{language}</Text><Pressable accessibilityRole="button" accessibilityLabel="复制代码" style={s.iconButton} onPress={() => void copyText(children).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? <Check color={c.accent} size={15} /> : <Copy color={c.muted} size={15} />}</Pressable></View><DrawerSwipeBlock><ScrollView horizontal style={{ flexGrow: 0 }}>{replySelection && NativeMessageText
    ? <View style={{ padding: 9, borderRadius: 4, backgroundColor: c.code }}><ReplyTextBlock runs={runs.map(run => ({ text: run.text, color: run.tone ? c[run.tone] : undefined }))} code minWidth={40} {...replySelection} /></View>
    : <Text selectable style={s.code}>{runs.map((run, index) => <Text key={index} style={run.tone && { color: c[run.tone] }}>{run.text}</Text>)}</Text>}</ScrollView></DrawerSwipeBlock></View>;
}
