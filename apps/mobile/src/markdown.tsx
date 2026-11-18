import { themedStyles } from './theme';
import { memo, useMemo } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { useTheme } from './styles';
import { CodeBlock } from './code-block';
import { DrawerSwipeBlock } from './drawer-swipe-block';
import { localFilePath } from '../../../packages/client-shared/src/file-links';
import { useFileLink } from './file-link-context';
import { PreviewContent } from './preview-content';
import { NativeMessageText } from './message-native';
import { ReplyTextBlock } from './message-selection';
import type { MessageTextRun } from '../../../packages/client-shared/src/message-text';

const parser = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(taskLists, { enabled: false });
const originalValidate = parser.validateLink.bind(parser);
parser.validateLink = value => {
  if (!originalValidate(value)) return false;
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(value, 'https://markdown.invalid/').protocol); }
  catch { return false; }
};
type Token = ReturnType<typeof parser.parse>[number];

const useMsStyles = themedStyles(c => StyleSheet.create({
  body: { color: c.text, fontSize: 16, lineHeight: 26 },
  paragraph: { marginBottom: 9 },
  h1: { color: c.heading, fontSize: 20, lineHeight: 27, fontWeight: '700', marginTop: 5, marginBottom: 8 },
  h2: { color: c.headingSecondary, fontSize: 18, lineHeight: 25, fontWeight: '700', marginTop: 5, marginBottom: 8 },
  h3: { color: c.headingSecondary, fontSize: 16, lineHeight: 23, fontWeight: '700', marginTop: 5, marginBottom: 6 },
  code: { color: c.text, backgroundColor: c.code, fontFamily: 'monospace', fontSize: 13 },
  codeBlock: { color: c.text, backgroundColor: c.code, fontFamily: 'monospace', fontSize: 13, lineHeight: 20, padding: 13, marginBottom: 11, borderRadius: 6 },
  listItem: { flexDirection: 'row', gap: 7, marginBottom: 4 }, bullet: { color: c.muted, width: 18, fontSize: 15, lineHeight: 23 }, listBody: { flex: 1 },
  quote: { borderLeftWidth: 2, borderLeftColor: c.accent, paddingLeft: 11, marginBottom: 8 },
  rule: { height: 1, backgroundColor: c.line, marginVertical: 10 },
  table: { borderWidth: 1, borderColor: c.line, marginBottom: 8 }, tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: c.line }, tableCell: { minWidth: 110, maxWidth: 220, padding: 8, borderRightWidth: 1, borderColor: c.line },
}));

type ReplySelection = { onSelection?: (active: boolean) => void; onCopied?: () => void };

export const Markdown = memo(function Markdown({ children, replySelection }: { children: string; replySelection?: true | ReplySelection }) {
  const selection = replySelection === true ? {} : replySelection;
  return <PreviewContent source={children} renderText={text => <MarkdownText selection={selection}>{text}</MarkdownText>} />;
});

function MarkdownText({ children, selection }: { children: string; selection?: ReplySelection }) {
  const { c } = useTheme();
  const ms = useMsStyles();
  const onFile = useFileLink();
  const openLink = (href: string) => {
    const path = localFilePath(href);
    if (path) onFile?.(path);
    else void Linking.openURL(href).catch(() => {});
  };
  function inline(tokens: Token[] | null | undefined, heading = 0, cellHeading = false): MessageTextRun[] {
    let strong = 0, emphasis = 0, strike = 0, link = '';
    const runs: MessageTextRun[] = [];
    for (const token of tokens ?? []) {
      if (token.type === 'strong_open') strong++;
      else if (token.type === 'strong_close') strong--;
      else if (token.type === 'em_open') emphasis++;
      else if (token.type === 'em_close') emphasis--;
      else if (token.type === 's_open') strike++;
      else if (token.type === 's_close') strike--;
      else if (token.type === 'link_open') {
        const href = String(token.attrGet('href') ?? '');
        link = (onFile && localFilePath(href)) || parser.validateLink(href) ? href : '';
      } else if (token.type === 'link_close') link = '';
      else if (token.type === 'softbreak' || token.type === 'hardbreak') runs.push({ text: '\n' });
      else if (token.type === 'image') runs.push({ text: token.content, color: c.muted });
      else if (token.type === 'html_inline' && token.content.startsWith('<input class="task-list-item-checkbox"')) runs.push({ text: token.content.includes('checked=""') ? '☑ ' : '☐ ', color: c.muted });
      else if (['text', 'code_inline', 'html_inline'].includes(token.type)) runs.push({
        text: token.content, bold: cellHeading || strong > 0, italic: emphasis > 0, strike: strike > 0,
        code: token.type === 'code_inline', heading,
        color: heading === 1 ? c.heading : heading > 0 ? c.headingSecondary : undefined,
        link: link || undefined,
      });
    }
    return runs;
  }
  function inlineText(runs: MessageTextRun[]) {
    return runs.map((run, index) => <Text key={index} accessibilityRole={run.link ? 'link' : undefined}
      style={[run.bold && { fontWeight: '700' }, run.italic && { fontStyle: 'italic' }, run.strike && { textDecorationLine: 'line-through' }, run.code && ms.code, { color: run.link ? c.accent : run.color }]}
      onPress={run.link ? () => openLink(run.link!) : undefined}>{run.text}</Text>);
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

  function blocks(tokens: Token[], prefix = 'b'): React.ReactNode[] {
    const output: React.ReactNode[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.type === 'paragraph_open' || token.type === 'heading_open') {
        const content = tokens[index + 1];
        const style = token.type === 'heading_open' ? token.tag === 'h1' ? ms.h1 : token.tag === 'h2' ? ms.h2 : ms.h3 : ms.paragraph;
        const runs = inline(content?.children, token.type === 'heading_open' ? Number(token.tag.slice(1)) : 0);
        output.push(selection && NativeMessageText
          ? <ReplyTextBlock key={`${prefix}:${index}`} runs={runs} style={{ marginTop: token.type === 'heading_open' ? 5 : 0, marginBottom: style.marginBottom }} onLink={openLink} {...selection} />
          : <Text key={`${prefix}:${index}`} selectable style={[ms.body, style]}>{inlineText(runs)}</Text>);
        index += 2;
      } else if (token.type === 'fence' || token.type === 'code_block') {
        output.push(<CodeBlock key={`${prefix}:${index}`} language={token.info || 'text'} replySelection={selection}>{token.content}</CodeBlock>);
      } else if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
        const end = closeIndex(tokens, index), ordered = token.type === 'ordered_list_open';
        const start = Number(token.attrGet('start') ?? 1);
        const rows: React.ReactNode[] = [];
        let number = start;
        for (let at = index + 1; at < end; at++) {
          if (tokens[at]!.type !== 'list_item_open') continue;
          const itemEnd = closeIndex(tokens, at);
          rows.push(<View key={`${prefix}:${at}`} style={ms.listItem}><Text style={ms.bullet}>{ordered ? `${number++}.` : '•'}</Text><View style={ms.listBody}>{blocks(tokens.slice(at + 1, itemEnd), `${prefix}:${at}`)}</View></View>);
          at = itemEnd;
        }
        output.push(<View key={`${prefix}:${index}`}>{rows}</View>);
        index = end;
      } else if (token.type === 'blockquote_open') {
        const end = closeIndex(tokens, index);
        output.push(<View key={`${prefix}:${index}`} style={ms.quote}>{blocks(tokens.slice(index + 1, end), `${prefix}:${index}`)}</View>);
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
            const runs = inline(tokens[cell + 1]?.children, 0, tokens[cell]!.type === 'th_open');
            cells.push(<View key={cell} style={ms.tableCell}>{selection && NativeMessageText
              ? <ReplyTextBlock runs={runs} minWidth={93} maxWidth={203} onLink={openLink} {...selection} />
              : <Text selectable={!!selection} style={ms.body}>{inlineText(runs)}</Text>}</View>);
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

  const parsed = useMemo(() => {
    const validate = parser.validateLink;
    try {
      parser.validateLink = value => (!!onFile && localFilePath(value) !== null) || validate(value);
      return parser.parse(children, {});
    } finally { parser.validateLink = validate; }
  }, [children, onFile]);
  const content = blocks(parsed);
  return selection && !NativeMessageText ? <DrawerSwipeBlock>{content}</DrawerSwipeBlock> : <View>{content}</View>;
}
