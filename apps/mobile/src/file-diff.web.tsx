import { diffLines } from '../../../packages/client-shared/src/diff';
import './file-diff.web.css';

export function FileDiff({ diff, path }: { diff: string; path: string }) {
  const lines = diffLines(diff);
  return <div className="codexer-file-diff" data-drawer-swipe="ignore" role="region" aria-label={`${path} 文件差异`} tabIndex={0}>
    <pre><code>{lines.map((line, index) => <span key={index} className={`codexer-diff-line codexer-diff-${line.kind}`} data-diff-kind={line.kind}>{line.text}{index < lines.length - 1 ? '\n' : ''}</span>)}</code></pre>
  </div>;
}
