import { numberedDiffLines } from '../../../packages/client-shared/src/diff';
import './file-diff.web.css';

export function FileDiff({ diff, path, fullHeight = false }: { diff: string; path: string; fullHeight?: boolean }) {
  const lines = numberedDiffLines(diff);
  return <div className="codexer-file-diff" style={fullHeight ? {maxHeight:'none'} : undefined} data-drawer-swipe="ignore" role="region" aria-label={`${path} 文件差异`} tabIndex={0}>
    <pre><code>{lines.map((line, index) => <span key={index} className={`codexer-diff-line codexer-diff-${line.kind}`} data-diff-kind={line.kind}><span className="codexer-diff-gutter" aria-hidden="true">{line.oldLine ?? ""}</span><span className="codexer-diff-gutter" aria-hidden="true">{line.newLine ?? ""}</span>{line.text}{index < lines.length - 1 ? '\n' : ''}</span>)}</code></pre>
  </div>;
}
