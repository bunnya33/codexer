import { afterEach, expect, it, vi } from "vitest";
import { clearWebCredentials, copyText, randomId, readWebCredentials, saveWebCredentials } from "../packages/client-shared/src/browser.js";
import { JSDOM } from 'jsdom';
afterEach(() => vi.unstubAllGlobals());

it('copies within a dialog focus trap when HTTP has no async clipboard API', async () => {
  const dom = new JSDOM('<div role="dialog" aria-modal="true"><button>Copy</button></div>');
  try {
    const document = dom.window.document, modal = document.querySelector('[role="dialog"]')!, button = document.querySelector('button')!;
    button.focus();
    document.addEventListener('focusin', () => { if (!modal.contains(document.activeElement)) button.focus(); });
    let clipboard = '';
    Object.assign(document, { execCommand: vi.fn((command: string) => {
      const field = document.activeElement as HTMLTextAreaElement;
      if (command !== 'copy' || field.tagName !== 'TEXTAREA' || field.selectionEnd !== field.value.length) return false;
      clipboard = field.value; return true;
    }) });
    vi.stubGlobal('document', document); vi.stubGlobal('navigator', {});
    await copyText('https://relay.test/share/中文-key');
    expect(clipboard).toBe('https://relay.test/share/中文-key');
    expect(document.querySelector('textarea')).toBeNull(); expect(document.activeElement).toBe(button);
    (document.execCommand as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await expect(copyText('failure')).rejects.toThrow('clipboard-unavailable');
    expect(document.querySelector('textarea')).toBeNull(); expect(document.activeElement).toBe(button);
  } finally { dom.window.close(); }
});

it('uses the async clipboard immediately when available and falls back after permission failure', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await copyText('share-url'); expect(writeText).toHaveBeenCalledWith('share-url');
  const dom = new JSDOM('<button>Copy</button>');
  try {
    vi.stubGlobal('document', dom.window.document);
    Object.assign(dom.window.document, { execCommand: vi.fn(() => true) });
    writeText.mockRejectedValueOnce(new Error('not-allowed'));
    await copyText('fallback-url'); expect(dom.window.document.execCommand).toHaveBeenCalledWith('copy');
  } finally { dom.window.close(); }
});

it('persists browser logins across tab replacement, migrates temporary sessions and clears both stores on logout', () => {
  const persistent = new Map<string,string>(), temporary = new Map<string,string>();
  const store = (values: Map<string,string>) => ({getItem: (key: string) => values.get(key) ?? null, setItem: (key: string,value: string) => values.set(key,value), removeItem: (key: string) => values.delete(key)});
  vi.stubGlobal('localStorage', store(persistent));vi.stubGlobal('sessionStorage', store(temporary));
  temporary.set('codexer.web.relay.v1control','saved-session');
  expect(readWebCredentials()).toBe('saved-session');expect(temporary.size).toBe(0);
  temporary.clear();expect(readWebCredentials()).toBe('saved-session');
  saveWebCredentials('another-session');expect(persistent.get('codexer.web.relay.v1control')).toBe('another-session');
  temporary.set('codexer.web.relay.v1control','old-session');clearWebCredentials();
  expect(persistent.size).toBe(0);expect(temporary.size).toBe(0);
});

it("keeps administrator and control logins separate across navigation and logout", () => {
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  saveWebCredentials("admin-session", store, "admin");
  expect(readWebCredentials(store, "control")).toBeNull();
  saveWebCredentials("control-session", store, "control");
  expect(readWebCredentials(store, "admin")).toBe("admin-session");
  clearWebCredentials(store, "admin");
  expect(readWebCredentials(store, "admin")).toBeNull();
  expect(readWebCredentials(store, "control")).toBe("control-session");
});

it("ignores legacy tokens and remembers the account session across refreshes", () => {
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  store.setItem("codexer.relay.admin-token.v1", "old-admin-token");
  store.setItem("codexer.web.relay.v1", JSON.stringify({ url: "http://relay.example", token: "old-access-token" }));
  expect(readWebCredentials(store)).toBeNull();
  expect(readWebCredentials(store, "admin")).toBeNull();
  const saved = JSON.stringify({ url: "http://different.example:9000", session: "test-account-session" });
  saveWebCredentials(saved, store);
  expect(store.getItem("codexer.relay.admin-token.v1")).toBeNull();
  expect(store.getItem("codexer.web.relay.v1")).toBeNull();
  expect(readWebCredentials(store)).toBe(saved);
  clearWebCredentials(store);
  expect(readWebCredentials(store)).toBeNull();
});

it("generates independent UUID v4 IDs when an HTTP context has no randomUUID API", () => {
  const httpCrypto = { getRandomValues: crypto.getRandomValues.bind(crypto) };
  const ids = Array.from({ length: 256 }, () => randomId(httpCrypto));
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

it("removes current and legacy credentials on logout", () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  saveWebCredentials("test-account-session", store);
  store.setItem("codexer.relay.admin-token.v1", "old-admin-token");
  store.setItem("codexer.web.relay.v1", "old-access-token");
  expect(readWebCredentials(store)).toBe("test-account-session");
  clearWebCredentials(store);
  expect(values.size).toBe(0);
});

it("continues without storage when the browser blocks it", () => {
  const blocked = {
    getItem: () => { throw new Error("storage-blocked"); },
    setItem: () => { throw new Error("storage-blocked"); },
    removeItem: () => { throw new Error("storage-blocked"); },
  };
  expect(readWebCredentials(blocked)).toBeNull();
  expect(() => saveWebCredentials("session", blocked)).toThrow("storage-blocked");
  expect(() => clearWebCredentials(blocked)).not.toThrow();
  expect(readWebCredentials()).toBeNull();
  expect(() => clearWebCredentials()).not.toThrow();
});
