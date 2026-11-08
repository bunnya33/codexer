export type DiffLine = { text: string; kind: 'addition' | 'deletion' | 'hunk' | 'metadata' | 'context' };

/** Line numbers come only from a unified patch's hunk header. */
export function numberedDiffLines(diff: string): (DiffLine & { oldLine?: number; newLine?: number })[] {
  let oldLine: number | undefined, newLine: number | undefined;
  return diffLines(diff).map(line => {
    if (line.text.startsWith('diff --git ')) { oldLine = undefined; newLine = undefined; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line.text);
    if (line.kind === 'hunk') { oldLine = hunk ? Number(hunk[1]) : undefined; newLine = hunk ? Number(hunk[2]) : undefined; return line; }
    if (line.kind === 'metadata' || oldLine === undefined || newLine === undefined) return line;
    if (line.kind === 'addition') return { ...line, newLine: newLine++ };
    if (line.kind === 'deletion') return { ...line, oldLine: oldLine++ };
    return { ...line, oldLine: oldLine++, newLine: newLine++ };
  });
}

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
