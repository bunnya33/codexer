import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Check, Copy } from 'lucide-react-native';
import { copyText } from './runtime';
import { useTheme } from './styles';
import { DrawerSwipeBlock } from './drawer-swipe-block';
import { codeRuns } from '../../../packages/client-shared/src/code-highlighting';

export function CodeBlock({ children, language = 'text' }: { children: string; language?: string }) {
  const { c, s } = useTheme();
  const [copied, setCopied] = useState(false);
  const runs = useMemo(() => codeRuns(children, language), [children, language]);
  return <View style={s.tool}><View style={s.toolHead}><Text style={[s.toolPreview, { flex: 1 }]}>{language}</Text><Pressable accessibilityRole="button" accessibilityLabel="复制代码" style={s.iconButton} onPress={() => void copyText(children).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? <Check color={c.accent} size={15} /> : <Copy color={c.muted} size={15} />}</Pressable></View><DrawerSwipeBlock><ScrollView horizontal style={{ flexGrow: 0 }}><Text selectable style={s.code}>{runs.map((run, index) => <Text key={index} style={run.tone && { color: c[run.tone] }}>{run.text}</Text>)}</Text></ScrollView></DrawerSwipeBlock></View>;
}
