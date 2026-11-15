import type { CodeRun } from './code-highlighting';

export type SourceMatch = { line: number; start: number; end: number };
export type SearchRun = CodeRun & { match?: boolean; active?: boolean };
export const SOURCE_SEARCH_LIMIT = 10_000;

/** Literal, non-overlapping matches. Keep offsets in the original text, including Unicode. */
export function searchSource(lines: readonly string[], query: string, matchCase = false) {
  const matches: SourceMatch[] = [];
  if (!query) return { matches, limited: false };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi');
  for (let line = 0; line < lines.length; line++) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lines[line]!))) {
      if (matches.length === SOURCE_SEARCH_LIMIT) return { matches, limited: true };
      matches.push({ line, start: match.index, end: match.index + match[0].length });
    }
  }
  return { matches, limited: false };
}

/** Split at search boundaries without discarding syntax colors or interpreting HTML. */
export function markSearchRuns(runs: readonly CodeRun[], matches: readonly SourceMatch[], active?: SourceMatch): readonly SearchRun[] {
  if (!matches.length) return runs;
  const result: SearchRun[] = [];
  let offset = 0, index = 0;
  for (const run of runs) {
    let start = 0;
    while (start < run.text.length) {
      while (index < matches.length && matches[index]!.end <= offset + start) index++;
      const match = matches[index];
      const inside = match && match.start <= offset + start;
      const end = Math.min(run.text.length, match ? (inside ? match.end : match.start) - offset : run.text.length);
      result.push({ ...run, text: run.text.slice(start, end), match: !!inside, active: !!inside && match === active });
      start = end;
    }
    offset += run.text.length;
  }
  return result;
}
