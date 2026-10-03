export type DiffLine = { text: string; kind: 'addition' | 'deletion' | 'hunk' | 'metadata' | 'context' };

/** Preserve the patch as text; file headers are not additions/deletions. */
export function diffLines(diff: string): DiffLine[] {
  if (!diff) return [];
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let inHunk = false;
  let headerEnd = -1;
  return lines.map((text, index) => {
    if (text.startsWith('diff --git ')) { inHunk = false; return { text, kind: 'metadata' }; }
    if (/^@@(?:@)?(?:\s|$)/.test(text)) { inHunk = true; return { text, kind: 'hunk' }; }
    if (!inHunk && text.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) headerEnd = index + 1;
    if (index <= headerEnd || /^\\ No newline at end of file/.test(text)
      || !inHunk && /^(?:index |(?:old|new|deleted file|new file) mode |(?:dis)?similarity index |(?:rename|copy) (?:from|to) |Binary files |GIT binary patch)/.test(text)) return { text, kind: 'metadata' };
    return { text, kind: text.startsWith('+') ? 'addition' : text.startsWith('-') ? 'deletion' : 'context' };
  });
}
