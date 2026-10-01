import { useMemo } from 'react';
import { renderMarkdown } from '../../../packages/client-shared/src/markdown';
import { copyText } from './runtime';
import './markdown.web.css';

export function Markdown({ children }: { children: string }) {
  const html = useMemo(() => renderMarkdown(children), [children]);
  return <div className="codexer-markdown" dangerouslySetInnerHTML={{ __html: html }} onClick={event => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('[data-action="copy-code"]');
    if (!button) return;
    const code = button.closest('.code-block')?.querySelector('code')?.textContent;
    if (code === undefined || code === null) return;
    void copyText(code).then(() => { button.textContent = '已复制'; setTimeout(() => { if (button.isConnected) button.textContent = '复制'; }, 1500); }).catch(() => { button.textContent = '请手动复制'; });
  }} />;
}
