import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

let javascript = '';
beforeAll(async () => {
  const result = await build({ entryPoints: ['apps/admin/src/main.tsx'], outdir: '.local/admin-session-tests', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  javascript = result.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
});

async function fixture(initialDays = 7) {
  let policy = { idleTimeoutMinutes: 10080, agentSessionDays: initialDays };
  const saved: unknown[] = [], errors: unknown[] = [];
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://admin.test/admin/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(window) {
    window.localStorage.setItem('codexer.admin.session.v2', 'fixture-admin');
    window.addEventListener('error', event => errors.push(event.error));
    Object.assign(window, { AbortSignal, fetch: async (input: string, init?: RequestInit) => {
      let value: unknown;
      if (input === '/v1/me') value = { role: 'admin' };
      else if (input === '/v1/admin/auth-settings') {
        if (init?.method === 'PUT') { const change = JSON.parse(String(init.body)); saved.push(change); policy = { ...policy, ...change }; }
        value = policy;
      } else if (input === '/v1/users') value = { users: [] };
      else if (input === '/v1/admin/accounts') value = { users: [], currentUserId: 'fixture-admin' };
      else if (input === '/v1/admin/overview') value = { users: 0, enabledUsers: 0, admins: 1, enabledAdmins: 1, onlineDevices: 0, onlineClients: 0, uptime: 10 };
      else if (input.startsWith('/v1/admin/system/version')) value = { currentVersion: '0.3.10', supported: false, tags: [] };
      else if (input === '/v1/auth/active') value = {};
      else throw new Error(`unexpected-request:${input}`);
      return new Response(JSON.stringify(value));
    } });
  } });
  dom.window.eval(javascript);
  await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('登录与权限'));
  const settings = [...dom.window.document.querySelectorAll('nav button')].find(button => button.textContent?.includes('系统设置'))!;
  (settings as HTMLElement).click();
  await vi.waitFor(() => expect(dom.window.document.querySelector('form[aria-label="PC Agent 登录有效期设置"]')).not.toBeNull());
  return { dom, saved, errors, getPolicy: () => policy };
}

it('saves custom days and never-expiring PC logins separately from browser inactivity', async () => {
  const { dom, saved, errors, getPolicy } = await fixture();
  try {
    const { document, Event } = dom.window;
    const form = document.querySelector('form[aria-label="PC Agent 登录有效期设置"]')!;
    const input = form.querySelector('input')!;
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(input, '90'); input.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(saved).toEqual([{ agentSessionDays: 90 }]));
    await vi.waitFor(() => expect(form.querySelector('button')!.disabled).toBe(false));
    const mode = form.querySelector('select')!;
    mode.value = 'never'; mode.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(form.querySelector('input')).toBeNull());
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(saved).toEqual([{ agentSessionDays: 90 }, { agentSessionDays: 0 }]));
    expect(getPolicy()).toEqual({ idleTimeoutMinutes: 10080, agentSessionDays: 0 });
    expect(form.textContent).toContain('已过期的登录需要重新登录');
    expect(errors).toEqual([]);
  } finally { dom.window.close(); }
});

it('restores never-expiring mode when reloading saved settings', async () => {
  const { dom, errors } = await fixture(0);
  try {
    const form = dom.window.document.querySelector('form[aria-label="PC Agent 登录有效期设置"]')!;
    await vi.waitFor(() => expect(form.querySelector('select')!.value).toBe('never'));
    expect(form.querySelector('input')).toBeNull(); expect(errors).toEqual([]);
  } finally { dom.window.close(); }
});
