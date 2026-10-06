import { useMemo } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { c } from './styles';
import { CodeBlock } from './code-block';
import { DrawerSwipeBlock } from './drawer-swipe-block';
import { localFilePath } from '../../../packages/client-shared/src/file-links';
import { useFileLink } from './file-link-context';

const parser = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(taskLists, { enabled: false });
const originalValidate = parser.validateLink.bind(parser);
parser.validateLink = value => {
  if (!originalValidate(value)) return false;
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(value, 'https://markdown.invalid/').protocol); }
  catch { return false; }
};
type Token = ReturnType<typeof parser.parse>[number];

const ms = StyleSheet.create({
  body: { color: c.text, fontSize: 16, lineHeight: 26 },
  paragraph: { marginBottom: 9 },
  h1: { color: c.text, fontSize: 20, lineHeight: 27, fontWeight: '700', marginTop: 5, marginBottom: 8 },
  h2: { color: c.text, fontSize: 18, lineHeight: 25, fontWeight: '700', marginTop: 5, marginBottom: 8 },
  h3: { color: c.text, fontSize: 16, lineHeight: 23, fontWeight: '700', marginTop: 5, marginBottom: 6 },
  code: { color: c.text, backgroundColor: c.code, fontFamily: 'monospace', fontSize: 13 },
  codeBlock: { color: c.text, backgroundColor: c.code, fontFamily: 'monospace', fontSize: 13, lineHeight: 20, padding: 13, marginBottom: 11, borderRadius: 6 },
  listItem: { flexDirection: 'row', gap: 7, marginBottom: 4 }, bullet: { color: c.muted, width: 18, fontSize: 15, lineHeight: 23 }, listBody: { flex: 1 },
  quote: { borderLeftWidth: 2, borderLeftColor: c.accent, paddingLeft: 11, marginBottom: 8 },
  rule: { height: 1, backgroundColor: c.line, marginVertical: 10 },
  table: { borderWidth: 1, borderColor: c.line, marginBottom: 8 }, tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: c.line }, tableCell: { minWidth: 110, maxWidth: 220, padding: 8, borderRightWidth: 1, borderColor: c.line },
});

function inline(tokens: Token[] = [], onFile?: (path: string) => void) {
  let strong = 0, emphasis = 0, strike = 0, link = '';
  return tokens.map((token, index) => {
    if (token.type === 'strong_open') { strong++; return null; }
    if (token.type === 'strong_close') { strong--; return null; }
    if (token.type === 'em_open') { emphasis++; return null; }
    if (token.type === 'em_close') { emphasis--; return null; }
    if (token.type === 's_open') { strike++; return null; }
    if (token.type === 's_close') { strike--; return null; }
    if (token.type === 'link_open') { const href = String(token.attrGet('href') ?? ''); link = (onFile && localFilePath(href)) || originalValidate(href) && parser.validateLink(href) ? href : ''; return null; }
    if (token.type === 'link_close') { link = ''; return null; }
    if (token.type === 'softbreak' || token.type === 'hardbreak') return <Text key={index}>{'\n'}</Text>;
    if (token.type === 'image') return <Text key={index} style={{ color: c.muted }}>{token.content}</Text>;
    if (token.type === 'html_inline' && token.content.startsWith('<input class="task-list-item-checkbox"')) return <Text key={index} style={{ color: c.muted }}>{token.content.includes('checked=""') ? '☑ ' : '☐ '}</Text>;
    if (token.type !== 'text' && token.type !== 'code_inline' && token.type !== 'html_inline') return null;
    const href = link;
    return <Text key={index} selectable accessibilityRole={href ? 'link' : undefined} style={[strong > 0 && { fontWeight: '700' }, emphasis > 0 && { fontStyle: 'italic' }, strike > 0 && { textDecorationLine: 'line-through' }, token.type === 'code_inline' && ms.code, href && { color: c.accent }]} onPress={href ? () => { const path = localFilePath(href); if (path) onFile?.(path); else void Linking.openURL(href); } : undefined}>{token.content}</Text>;
  });
}

function closeIndex(tokens: Token[], from: number): number {
  const type = tokens[from]!.type.replace(/_open$/, '');
  let depth = 0;
  for (let index = from; index < tokens.length; index++) {
    if (tokens[index]!.type === `${type}_open`) depth++;
    if (tokens[index]!.type === `${type}_close` && --depth === 0) return index;
  }
  return tokens.length - 1;
}

function blocks(tokens: Token[], prefix = 'b', onFile?: (path: string) => void): React.ReactNode[] {
  const output: React.ReactNode[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === 'paragraph_open' || token.type === 'heading_open') {
      const content = tokens[index + 1];
      const style = token.type === 'heading_open' ? token.tag === 'h1' ? ms.h1 : token.tag === 'h2' ? ms.h2 : ms.h3 : ms.paragraph;
      output.push(<Text key={`${prefix}:${index}`} selectable style={[ms.body, style]}>{inline(content?.children ?? [], onFile)}</Text>);
      index += 2;
    } else if (token.type === 'fence' || token.type === 'code_block') {
      output.push(<CodeBlock key={`${prefix}:${index}`} language={token.info || 'text'}>{token.content}</CodeBlock>);
    } else if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      const end = closeIndex(tokens, index), ordered = token.type === 'ordered_list_open';
      const start = Number(token.attrGet('start') ?? 1);
      const rows: React.ReactNode[] = [];
      let number = start;
      for (let at = index + 1; at < end; at++) {
        if (tokens[at]!.type !== 'list_item_open') continue;
        const itemEnd = closeIndex(tokens, at);
        rows.push(<View key={`${prefix}:${at}`} style={ms.listItem}><Text style={ms.bullet}>{ordered ? `${number++}.` : '•'}</Text><View style={ms.listBody}>{blocks(tokens.slice(at + 1, itemEnd), `${prefix}:${at}`, onFile)}</View></View>);
        at = itemEnd;
      }
      output.push(<View key={`${prefix}:${index}`}>{rows}</View>);
      index = end;
    } else if (token.type === 'blockquote_open') {
      const end = closeIndex(tokens, index);
      output.push(<View key={`${prefix}:${index}`} style={ms.quote}>{blocks(tokens.slice(index + 1, end), `${prefix}:${index}`, onFile)}</View>);
      index = end;
    } else if (token.type === 'table_open') {
      const end = closeIndex(tokens, index);
      const rows: React.ReactNode[] = [];
      for (let at = index + 1; at < end; at++) {
        if (tokens[at]!.type !== 'tr_open') continue;
        const rowEnd = closeIndex(tokens, at);
        const cells: React.ReactNode[] = [];
        for (let cell = at + 1; cell < rowEnd; cell++) {
          if (!['th_open', 'td_open'].includes(tokens[cell]!.type)) continue;
          cells.push(<View key={cell} style={ms.tableCell}><Text style={[ms.body, tokens[cell]!.type === 'th_open' && { fontWeight: '700' }]}>{inline(tokens[cell + 1]?.children ?? [], onFile)}</Text></View>);
          cell = closeIndex(tokens, cell);
        }
        rows.push(<View key={at} style={ms.tableRow}>{cells}</View>);
        at = rowEnd;
      }
      output.push(<DrawerSwipeBlock key={`${prefix}:${index}`}><ScrollView horizontal style={{ flexGrow: 0 }}><View style={ms.table}>{rows}</View></ScrollView></DrawerSwipeBlock>);
      index = end;
    } else if (token.type === 'hr') output.push(<View key={`${prefix}:${index}`} style={ms.rule} />);
  }
  return output;
}

export function Markdown({ children }: { children: string }) {
  const onFile = useFileLink();
  const parsed = useMemo(() => {
    const validate = parser.validateLink;
    try {
      parser.validateLink = value => (!!onFile && localFilePath(value) !== null) || validate(value);
      return parser.parse(children, {});
    } finally { parser.validateLink = validate; }
  }, [children, onFile]);
  return <View>{blocks(parsed, 'b', onFile)}</View>;
}
