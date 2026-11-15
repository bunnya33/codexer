import { expect, it } from 'vitest';
import { markSearchRuns, searchSource, SOURCE_SEARCH_LIMIT } from '../packages/client-shared/src/source-search';

it('finds literal Unicode text with original line and column offsets and optional case sensitivity', () => {
  const lines = ['İ 中文 🐸 local value = Value', 'return value .. ".*[]\\"'];
  expect(searchSource(lines, 'value').matches).toEqual([{ line: 0, start: 14, end: 19 }, { line: 0, start: 22, end: 27 }, { line: 1, start: 7, end: 12 }]);
  expect(searchSource(lines, 'Value', true).matches).toEqual([{ line: 0, start: 22, end: 27 }]);
  expect(searchSource(lines, '.*[]\\').matches).toEqual([{ line: 1, start: 17, end: 22 }]);
  expect(searchSource(lines, '中文').matches).toEqual([{ line: 0, start: 2, end: 4 }]);
  expect(searchSource(lines, '').matches).toEqual([]);
  expect(searchSource(lines, 'missing').matches).toEqual([]);
});

it('bounds retained matches on repetitive large files and indicates truncation accurately', () => {
  const exact = searchSource(['x '.repeat(SOURCE_SEARCH_LIMIT)], 'x');
  expect(exact.matches).toHaveLength(SOURCE_SEARCH_LIMIT);
  expect(exact.limited).toBe(false);
  const extra = searchSource(['x '.repeat(SOURCE_SEARCH_LIMIT + 1)], 'x');
  expect(extra.matches).toHaveLength(SOURCE_SEARCH_LIMIT);
  expect(extra.limited).toBe(true);
});

it('marks a match across syntax spans without altering source text or other colors', () => {
  const runs = [{ text: 'local', tone: 'syntaxKeyword' as const }, { text: ' value = ' }, { text: '"<script>🐸 &amp;"', tone: 'syntaxString' as const }];
  const source = runs.map(run => run.text).join('');
  const matches = searchSource([source], 'al value').matches;
  const marked = markSearchRuns(runs, matches, matches[0]);
  expect(marked.map(run => run.text).join('')).toBe(source);
  expect(marked.filter(run => run.active).map(run => run.text).join('')).toBe('al value');
  expect(marked[0]).toMatchObject({ text: 'loc', tone: 'syntaxKeyword', match: false });
  expect(marked[1]).toMatchObject({ text: 'al', tone: 'syntaxKeyword', active: true });
  expect(marked.at(-1)).toMatchObject(runs.at(-1)!);
  expect(markSearchRuns(runs, [])).toBe(runs);
});
