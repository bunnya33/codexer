import { getDocument, TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

// Run PDF.js inside the isolated viewer. No document JavaScript or external links run.
Object.assign(globalThis, { pdfjsWorker: { WorkerMessageHandler } });
type Configuration = { data: string; base: string; channel: string };
const config = (window as unknown as { codexerDocument: Configuration }).codexerDocument;
const style = document.createElement('style');
style.textContent = `
html,body{margin:0;width:100%;height:100%;font:14px/1.45 system-ui,sans-serif;color:#22282b;background:#edf0f2}*{box-sizing:border-box}
body{display:flex;flex-direction:column;overflow:hidden}button,input{font:inherit}button{min-width:40px;min-height:40px;padding:6px 10px;background:transparent;border:1px solid #d9dfe3;border-radius:7px;color:inherit;cursor:pointer}button:disabled{opacity:.35;cursor:default}button[aria-pressed=true]{color:#285ad6;background:#e9efff;border-color:#aec3ff}input{min-width:0;min-height:40px;border:1px solid #d9dfe3;border-radius:7px;padding:6px 10px;font-size:16px;color:inherit;background:#fff}button:focus-visible,input:focus-visible{outline:2px solid #3970e6;outline-offset:1px}
header{background:#fff;border-bottom:1px solid #d9dfe3;padding:8px;flex-shrink:0}.row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.search{margin-top:8px}.search input{flex:1;width:100px}.spacer{flex:1}#page{width:60px;text-align:center}#pages,#zoom-label,#matches{font-size:12px;color:#67737c;white-space:nowrap}#status{font-size:12px;color:#67737c;padding-top:5px}#status:empty{display:none}#viewport{flex:1;min-height:0;overflow:auto;padding:16px;overscroll-behavior:contain;touch-action:pan-x pan-y pinch-zoom}#paper{position:relative;margin:0 auto;background:white;box-shadow:0 1px 6px #0002}canvas{display:block;width:100%;height:100%}.textLayer{position:absolute;inset:0;overflow:clip;line-height:1;text-align:initial;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;caret-color:CanvasText;z-index:2}.textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}.textLayer> :not(.markedContent),.textLayer .markedContent span:not(.markedContent){z-index:1}.textLayer span.markedContent{display:contents}.textLayer ::selection{background:#3970e666}.textLayer mark{color:transparent;background:#ffe06a99}.textLayer mark.active{background:#79b2ffb0}.error{padding:24px;color:#9d3434;background:#fff;line-height:1.8}.textLayer{--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}.textLayer> :not(.markedContent),.textLayer .markedContent span:not(.markedContent){font-size:calc(var(--text-scale-factor) * var(--font-height));transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
@media(max-width:440px){#viewport{padding:8px}header{padding:6px}.row{gap:4px}button{padding:6px 8px;min-width:36px}#page{width:49px}.search input{width:80px}#zoom-label{display:none}}
`;
document.head.append(style);
document.body.replaceChildren();
const header = document.createElement('header'), toolbar = document.createElement('div'), searchbar = document.createElement('div');
toolbar.className = 'row'; searchbar.className = 'row search';
const status = document.createElement('div'); status.id = 'status'; status.role = 'status';
header.append(toolbar, searchbar, status);
const viewport = document.createElement('main'); viewport.id = 'viewport'; viewport.ariaLabel = '文档页面';
const paper = document.createElement('div'); paper.id = 'paper'; viewport.append(paper);
document.body.append(header, viewport);
function button(parent: Element, label: string, text: string, action: () => void) {
  const node = document.createElement('button'); node.type = 'button'; node.ariaLabel = label; node.title = label; node.textContent = text; node.addEventListener('click', action); parent.append(node); return node;
}
const previous = button(toolbar, '上一页', '‹', () => go(pageNumber - 1));
const pageInput = document.createElement('input'); pageInput.id = 'page'; pageInput.type = 'number'; pageInput.min = '1'; pageInput.ariaLabel = '页码'; toolbar.append(pageInput);
const pages = document.createElement('span'); pages.id = 'pages'; toolbar.append(pages);
const next = button(toolbar, '下一页', '›', () => go(pageNumber + 1));
const spacer = document.createElement('span'); spacer.className = 'spacer'; toolbar.append(spacer);
button(toolbar, '缩小', '−', () => { zoom = Math.max(.5, zoom - .25); void render(); });
const zoomLabel = document.createElement('span'); zoomLabel.id = 'zoom-label'; toolbar.append(zoomLabel);
button(toolbar, '放大', '+', () => { zoom = Math.min(3, zoom + .25); void render(); });
button(toolbar, '适合宽度', '适宽', () => { zoom = 1; void render(); });
const searchInput = document.createElement('input'); searchInput.type = 'search'; searchInput.placeholder = '搜索文档内容'; searchInput.ariaLabel = '搜索文档内容'; searchInput.autocomplete = 'off'; searchbar.append(searchInput);
const caseButton = button(searchbar, '区分大小写', 'Aa', () => { matchCase = !matchCase; caseButton.ariaPressed = String(matchCase); void search(); });
caseButton.ariaPressed = 'false';
const matchesLabel = document.createElement('span'); matchesLabel.id = 'matches'; matchesLabel.role = 'status'; searchbar.append(matchesLabel);
const previousMatch = button(searchbar, '上一个匹配', '↑', () => navigateMatch(-1));
const nextMatch = button(searchbar, '下一个匹配', '↓', () => navigateMatch(1));
let pdf: PDFDocumentProxy | undefined, pageNumber = 1, zoom = 1, renderVersion = 0, searchVersion = 0;
let renderTask: RenderTask | undefined, textLayer: TextLayer | undefined;
let matchCase = false, matches: { page: number; start: number; end: number }[] = [], matchIndex = 0, query = '', limited = false;
let searchTimer: ReturnType<typeof setTimeout>;
pageInput.addEventListener('change', () => go(Number(pageInput.value)));
pageInput.addEventListener('keydown', event => { if (event.key === 'Enter') go(Number(pageInput.value)); });
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer); searchVersion++; query = searchInput.value; matches = []; matchIndex = 0; limited = false;
  updateMatches(); highlight(); searchTimer = setTimeout(() => void search(), 180);
});
searchInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); navigateMatch(event.shiftKey ? -1 : 1); } });
window.addEventListener('resize', () => { void render(); });
function go(value: number) {
  if (!pdf) return;
  pageNumber = Math.max(1, Math.min(pdf.numPages, Math.trunc(value) || 1));
  viewport.scrollTo(0, 0); void render();
}
function fail(error: unknown) {
  paper.replaceChildren(); const message = document.createElement('div'); message.className = 'error'; message.role = 'alert';
  message.textContent = error && typeof error === 'object' && 'name' in error && error.name === 'PasswordException' ? '此 PDF 受密码保护，请下载后在本机解锁查看。' : '文档无法显示，文件可能已损坏或包含暂不支持的内容。可下载原文件查看。';
  paper.append(message); status.textContent = '';
}
async function render() {
  if (!pdf) return;
  const version = ++renderVersion;
  renderTask?.cancel(); textLayer?.cancel();
  previous.disabled = pageNumber <= 1; next.disabled = pageNumber >= pdf.numPages;
  pageInput.value = String(pageNumber); pageInput.max = String(pdf.numPages); pages.textContent = `/ ${pdf.numPages}`;
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`; status.textContent = '正在渲染页面…';
  try {
    const page = await pdf.getPage(pageNumber);
    if (version !== renderVersion) return;
    const original = page.getViewport({ scale: 1 });
    const fit = Math.max(100, viewport.clientWidth - (viewport.clientWidth <= 440 ? 16 : 32)) / original.width;
    const scale = Math.min(fit * zoom, 4096 / Math.max(original.width, original.height));
    const view = page.getViewport({ scale });
    const ratio = Math.min(devicePixelRatio || 1, 2, 4096 / Math.max(view.width, view.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(view.width * ratio); canvas.height = Math.ceil(view.height * ratio);
    paper.style.width = `${view.width}px`; paper.style.height = `${view.height}px`;
    paper.style.setProperty('--total-scale-factor', String(scale)); paper.style.setProperty('--scale-factor', String(scale));
    const layer = document.createElement('div'); layer.className = 'textLayer';
    paper.replaceChildren(canvas, layer);
    renderTask = page.render({ canvas, viewport: view, transform: [ratio, 0, 0, ratio, 0, 0], isEditing: false });
    await renderTask.promise;
    if (version !== renderVersion) return;
    const content = await page.getTextContent();
    if (version !== renderVersion) return;
    textLayer = new TextLayer({ textContentSource: content, container: layer, viewport: view });
    await textLayer.render();
    if (version !== renderVersion) return;
    highlight(); status.textContent = '';
    parent.postMessage({ channel: config.channel, type: 'document-ready', pages: pdf.numPages }, '*');
  } catch (error) {
    if (version === renderVersion && !(error instanceof Error && error.name === 'RenderingCancelledException')) fail(error);
  }
}
function updateMatches() {
  matchesLabel.textContent = query ? (matches.length ? `${matchIndex + 1}/${matches.length}${limited ? '+' : ''}` : '无匹配') : '';
  previousMatch.disabled = nextMatch.disabled = !matches.length;
}
function highlight() {
  const spans = [...paper.querySelectorAll<HTMLElement>('.textLayer span[role="presentation"]')];
  const pageMatches = matches.filter(match => match.page === pageNumber), active = matches[matchIndex];
  let offset = 0, firstMatch = 0;
  for (const span of spans) {
    const text = span.textContent ?? ''; span.replaceChildren();
    let cursor = 0;
    while (pageMatches[firstMatch] && pageMatches[firstMatch]!.end <= offset) firstMatch++;
    for (let index = firstMatch; index < pageMatches.length && pageMatches[index]!.start < offset + text.length; index++) {
      const match = pageMatches[index]!;
      const start = Math.max(0, match.start - offset), end = Math.min(text.length, match.end - offset);
      if (start >= end) continue;
      span.append(document.createTextNode(text.slice(cursor, start)));
      const mark = document.createElement('mark'); mark.textContent = text.slice(start, end); if (match === active) mark.className = 'active'; span.append(mark); cursor = end;
    }
    span.append(document.createTextNode(text.slice(cursor))); offset += text.length;
  }
  paper.querySelector('mark.active')?.scrollIntoView({ block: 'center', inline: 'nearest' });
}
async function search() {
  if (!pdf) return;
  const version = ++searchVersion;
  query = searchInput.value; matches = []; matchIndex = 0; limited = false; updateMatches(); highlight();
  if (!query) { status.textContent = ''; return; }
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi');
  try {
    for (let page = 1; page <= pdf.numPages; page++) {
      if (version !== searchVersion) return;
      status.textContent = `正在搜索 ${page} / ${pdf.numPages} 页…`;
      const content = await (await pdf.getPage(page)).getTextContent();
      if (version !== searchVersion) return;
      const text = content.items.map(item => 'str' in item ? item.str : '').join('');
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text))) {
        if (matches.length === 10000) { limited = true; break; }
        matches.push({ page, start: match.index, end: match.index + match[0].length });
      }
      if (limited) break;
    }
    if (version !== searchVersion) return;
    status.textContent = limited ? '仅定位前 10,000 处匹配，请缩小搜索范围。' : matches.length ? '' : '未找到匹配文字。扫描件需要先进行文字识别。';
    updateMatches();
    if (matches[0]) go(matches[0].page); else highlight();
  } catch { if (version === searchVersion) status.textContent = '部分文字无法搜索，可继续按页阅读。'; }
}
function navigateMatch(direction: number) {
  if (!matches.length) return;
  matchIndex = (matchIndex + direction + matches.length) % matches.length; updateMatches();
  if (pageNumber === matches[matchIndex]!.page) highlight(); else go(matches[matchIndex]!.page);
}
updateMatches();
void (async () => {
  const data = Uint8Array.from(atob(config.data), character => character.charCodeAt(0));
  const loading = getDocument({ data, enableXfa: false, disableWorkerRendering: true, useSystemFonts: true, cMapUrl: config.base + 'cmaps/', cMapPacked: true, standardFontDataUrl: config.base + 'standard_fonts/', wasmUrl: config.base + 'wasm/', useWorkerFetch: false });
  window.addEventListener('pagehide', () => { searchVersion++; renderVersion++; renderTask?.cancel(); void loading.destroy(); }, { once: true });
  pdf = await loading.promise;
  await render();
})().catch(fail);
