import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';
import { controlTheme } from '../packages/client-shared/src/themes';

let javascript = '', css = '';
beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/task-status-app.tsx'], outdir: '.local/task-status-tests', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'], nodePaths: [resolve('apps/mobile/node_modules')], alias: { 'react-native': 'react-native-web' },
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis', 'process.env': '{}' } });
  javascript = result.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
  css = result.outputFiles!.find(file => file.path.endsWith('.css'))?.text ?? '';
});

async function fixture(theme = 'default') {
  const errors: unknown[] = [];
  const dom = new JSDOM(`<style>${css}</style><div id="root"></div>`, { url: 'http://fixture.test', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(window) {
    window.addEventListener('error', event => errors.push(event.error));
    Object.assign(window, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
    window.matchMedia = (() => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    window.localStorage.setItem('codexer.control.theme.v1', theme);
  } });
  dom.window.eval(javascript);
  const doc = dom.window.document;
  await vi.waitFor(() => expect(doc.querySelector('[data-testid="turn-token-usage"]')).not.toBeNull());
  const click = (label: string) => (doc.querySelector(`[aria-label="${label}"]`) as HTMLElement).click();
  return { doc, click, errors, style: (element: Element) => dom.window.getComputedStyle(element), close() { (dom.window as unknown as { taskStatusFixture: { close(): void } }).taskStatusFixture.close(); dom.window.close(); } };
}

it('places running markers before the title and tokens, with a spinner only at processing duration', async () => {
  const f = await fixture();
  try {
    const header = f.doc.querySelector('[data-testid="conversation-header"]')!;
    const dot = header.querySelector('[aria-label="当前会话正在运行"]')!;
    expect(dot.compareDocumentPosition(header.querySelector('[data-testid="conversation-title"]')!) & 4).toBe(4);
    const usage = f.doc.querySelector('[data-testid="turn-token-usage"]')!;
    expect(usage.firstElementChild?.getAttribute('aria-label')).toBe('任务进行中');
    expect(usage.textContent).toContain('输入 1,000');
    const spinner = f.doc.querySelector('[data-testid="processing-spinner"]')!;
    expect(spinner).not.toBeNull();
    expect(spinner.parentElement?.querySelector('[data-testid="task-status-dot"]')).toBeNull();
    expect(f.doc.querySelector('[data-testid="turn-end-time"]')).toBeNull();
    expect(usage.querySelector('[data-testid="turn-cost"]')?.textContent).toBe(' · $0.0038');
    expect(usage.textContent).not.toContain('预估');
    expect(f.errors).toEqual([]);
  } finally { f.close(); }
});

it('removes running markers and backgrounds on completion while retaining tokens and a green check', async () => {
  const f = await fixture();
  try {
    f.click('切换任务状态');
    await vi.waitFor(() => expect(f.doc.querySelectorAll('.codexer-task-dot-running').length).toBe(0));
    expect(f.doc.querySelector('[data-testid="processing-spinner"]')).toBeNull();
    expect(f.doc.querySelector('[data-testid="turn-token-usage"]')?.textContent).toContain('输入 1,000');
    expect(f.doc.querySelector('[data-testid="activity-ended-check"] svg')).not.toBeNull();
    expect(f.doc.querySelector('[data-testid="activity-ended-check"] [data-testid="task-status-dot"]')).toBeNull();
    expect(f.style(f.doc.querySelector('[data-testid="directory-project-heading-project"]')!).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(f.style(f.doc.querySelector('[data-testid="directory-thread-fixture"]')!).backgroundColor).toBe('rgb(238, 244, 247)');
    expect(f.doc.querySelector('[data-testid="turn-end-time"]')?.textContent).toContain('已完成');
    expect(f.doc.querySelector('[data-testid="turn-end-time"]')?.textContent).toMatch(/已完成$/);
    expect(f.doc.querySelector('[data-testid="turn-end-time"] [data-testid="turn-cost"]')).toBeNull();
    expect(f.doc.querySelector('[data-testid="turn-token-usage"] [data-testid="turn-cost"]')?.textContent).toBe(' · $0.0038');
  } finally { f.close(); }
});

it('shows only the chat marker when expanded and transfers activity to the project marker when collapsed', async () => {
  const f = await fixture();
  try {
    expect(f.doc.querySelector('[aria-label="项目 示例项目 有会话正在运行，1 个会话运行中"]')).toBeNull();
    const chatDot = f.doc.querySelector('[aria-label="正在运行：示例会话"]')!;
    expect(chatDot.nextElementSibling?.textContent).toBe('示例会话');
    f.click('收起项目 示例项目');
    await vi.waitFor(() => expect(f.doc.querySelector('[aria-label="展开项目 示例项目"]')).not.toBeNull());
    expect(f.doc.querySelector('[aria-label="项目 示例项目 有会话正在运行，1 个会话运行中"]')?.nextElementSibling?.textContent).toBe('示例项目');
    expect(f.doc.querySelector('[aria-label="正在运行：示例会话"]')).toBeNull();
    f.click('展开项目 示例项目');
    await vi.waitFor(() => expect(f.doc.querySelector('[aria-label="正在运行：示例会话"]')).not.toBeNull());
    expect(f.doc.querySelector('[aria-label="项目 示例项目 有会话正在运行，1 个会话运行中"]')).toBeNull();
  } finally { f.close(); }
});

it.each(['default', 'paper', 'warm-dark'])('highlights running projects and chats separately in the %s theme, retaining selection', async theme => {
  const f = await fixture(theme);
  try {
    const rgb = (hex: string) => `rgb(${[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;
    const colors = controlTheme(theme).colors;
    const project = f.doc.querySelector('[data-testid="directory-project-heading-project"]')!;
    const chat = f.doc.querySelector('[data-testid="directory-thread-fixture"]')!;
    expect(f.style(project).backgroundColor).toBe(rgb(colors.taskProjectBg));
    expect(f.style(chat).backgroundColor).toBe(rgb(colors.taskThreadBg));
    expect(f.style(chat).borderTopColor).toBe(rgb(colors.accent));
    f.click('收起项目 示例项目');
    await vi.waitFor(() => expect(f.doc.querySelector('[aria-label="项目 示例项目 有会话正在运行，1 个会话运行中"]')).not.toBeNull());
    expect(f.style(project).backgroundColor).toBe(rgb(colors.taskProjectBg));
  } finally { f.close(); }
});

it('shows running token status before the first usage report and removes it when the turn ends', async () => {
  const f = await fixture();
  try {
    f.click('切换 Token 数据');
    await vi.waitFor(() => expect(f.doc.querySelector('[data-testid="turn-token-usage"]')?.textContent).toBe('Token 统计中'));
    expect(f.doc.querySelector('[data-testid="turn-token-usage"] [aria-label="任务进行中"]')).not.toBeNull();
    f.click('切换任务状态');
    await vi.waitFor(() => expect(f.doc.querySelector('[data-testid="turn-token-usage"]')).toBeNull());
    expect(f.doc.querySelector('[data-testid="turn-cost"]')).toBeNull();
  } finally { f.close(); }
});

it('updates the amount beside tokens as running usage arrives and retains it after completion', async () => {
  const f = await fixture();
  try {
    const amount = () => f.doc.querySelector('[data-testid="turn-token-usage"] [data-testid="turn-cost"]');
    expect(amount()?.textContent).toBe(' · $0.0038');
    f.click('增加 Token 用量');
    await vi.waitFor(() => expect(amount()?.textContent).toBe(' · $0.0075'));
    expect(f.doc.querySelector('[data-testid="turn-token-usage"]')?.textContent).toContain('输入 2,000');
    expect(f.doc.querySelector('[data-testid="turn-end-time"]')).toBeNull();
    f.click('切换任务状态');
    await vi.waitFor(() => expect(f.doc.querySelector('[data-testid="turn-end-time"]')?.textContent).toMatch(/已完成$/));
    expect(amount()?.textContent).toBe(' · $0.0075');
    expect(f.doc.querySelectorAll('[data-testid="turn-cost"]').length).toBe(1);
    expect(f.errors).toEqual([]);
  } finally { f.close(); }
});

it('shows counts only for concurrent chats on the device and collapsed project, and updates on completion', async () => {
  const f = await fixture();
  try {
    const device = () => f.doc.querySelector('[data-testid="device-task-badge"]')!;
    expect(device().querySelector('[data-testid="task-status-dot"]')).not.toBeNull();
    expect(f.doc.querySelector('[data-testid="running-task-number"]')).toBeNull();
    f.click('切换并行会话');
    await vi.waitFor(() => expect(device().querySelector('[data-testid="running-task-number"]')?.textContent).toBe('2'));
    expect(f.doc.querySelectorAll('[data-testid="running-task-number"]').length).toBe(1);
    f.click('收起项目 示例项目');
    await vi.waitFor(() => expect(f.doc.querySelectorAll('[data-testid="running-task-number"]').length).toBe(2));
    expect(f.doc.querySelector('[aria-label="项目 示例项目 有会话正在运行，2 个会话运行中"]')).not.toBeNull();
    f.click('切换并行会话');
    await vi.waitFor(() => expect(f.doc.querySelector('[data-testid="running-task-number"]')).toBeNull());
    expect(device().querySelector('[data-testid="task-status-dot"]')).not.toBeNull();
    f.click('切换任务状态');
    await vi.waitFor(() => expect(f.doc.querySelector('[data-testid="device-task-badge"]')).toBeNull());
  } finally { f.close(); }
});

it('shows only the current chat total and cached-input cost breakdown in the header', async () => {
  const f = await fixture();
  try {
    expect(f.doc.querySelector('[data-testid="thread-usage-summary"]')?.textContent).toBe('会话累计 1,200 Token · 预估 $0.0038');
    expect(f.doc.querySelector('[data-testid="project-usage-summary"]')).toBeNull();
    f.click('会话用量详情，会话累计 1,200 Token · 预估 $0.0038');
    await vi.waitFor(() => expect(f.doc.body.textContent).toContain('只统计当前设备的当前会话'));
    expect(f.doc.body.textContent).toContain('缓存命中 500');
    expect(f.doc.body.textContent).not.toContain('含已归档会话');
    expect(f.doc.body.textContent).toContain('不是订阅扣款或实际账单');
    expect(f.errors).toEqual([]);
  } finally { f.close(); }
});
