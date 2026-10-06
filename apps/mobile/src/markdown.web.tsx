import { useMemo } from 'react';
import { renderMarkdown } from '../../../packages/client-shared/src/markdown';
import { copyText } from './runtime';
import './markdown.web.css';
import { useFileLink } from './file-link-context';

export function Markdown({ children }: { children: string }) {
  const onFile = useFileLink();
  const html = useMemo(() => renderMarkdown(children, undefined, !!onFile), [children, onFile]);
  return <div className="codexer-markdown" dangerouslySetInnerHTML={{ __html: html }} onClick={event => {
    const target = event.target as HTMLElement;
    const file = target.closest<HTMLAnchorElement>('[data-file-path]');
    if (file) { event.preventDefault(); onFile?.(file.dataset.filePath!); return; }
    const button = target.closest<HTMLButtonElement>('[data-action="copy-code"]');
    if (!button) return;
    const code = button.closest('.code-block')?.querySelector('code')?.textContent;
    if (code === undefined || code === null) return;
    void copyText(code).then(() => { button.textContent = '已复制'; setTimeout(() => { if (button.isConnected) button.textContent = '复制'; }, 1500); }).catch(() => { button.textContent = '请手动复制'; });
  }} />;
}
