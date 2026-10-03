import { expect, it } from 'vitest';
import { diffLines } from '../packages/client-shared/src/diff';

it('colors patch additions and deletions while keeping file headers and hunks distinct', () => {
  const patch = 'diff --git a/helper.ts b/helper.ts\nindex 123..456 100644\n--- a/helper.ts\n+++ b/helper.ts\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n\\ No newline at end of file\n';
  expect(diffLines(patch).map(line => line.kind)).toEqual(['metadata', 'metadata', 'metadata', 'metadata', 'hunk', 'context', 'deletion', 'addition', 'metadata']);
});

it('does not misclassify code starting with multiple plus/minus signs inside a hunk', () => {
  expect(diffLines('@@ -1 +1 @@\n--- literal\n+++ literal').map(line => line.kind)).toEqual(['hunk', 'deletion', 'addition']);
});

it('handles headerless whole-file add/delete patches and leaves ordinary content unchanged', () => {
  expect(diffLines('+one\n+++counter;\n+').map(line => line.kind)).toEqual(['addition', 'addition', 'addition']);
  expect(diffLines('-one\n---counter;').map(line => line.kind)).toEqual(['deletion', 'deletion']);
  expect(diffLines('plain text\r\n\t<script>literal</script>\r\n\r\n').map(line => line.text)).toEqual(['plain text', '\t<script>literal</script>', '']);
  expect(diffLines('')).toEqual([]);
});
