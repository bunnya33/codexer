type BrowserCrypto = Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>;
type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const LEGACY_TOKEN_KEY = "codexer.relay.admin-token.v1";
const CREDENTIAL_KEY = "codexer.web.relay.v1";

export function readWebCredentials(store?: SessionStore, scope = 'control'): string | null {
  try {
    const storage = store ?? sessionStorage;
    return storage.getItem(CREDENTIAL_KEY + scope);
  } catch { return null; }
}

export function saveWebCredentials(value: string, store?: SessionStore, scope = 'control'): void {
  const storage = store ?? sessionStorage;
  storage.setItem(CREDENTIAL_KEY + scope, value);
  clearLegacyCredentials(storage);
}

export function clearWebCredentials(store?: SessionStore, scope = 'control'): void {
  try { const storage = store ?? sessionStorage; storage.removeItem(CREDENTIAL_KEY + scope); clearLegacyCredentials(storage); }
  catch { /* Logout still works when browser storage is blocked. */ }
}

function clearLegacyCredentials(store: SessionStore): void {
  store.removeItem(LEGACY_TOKEN_KEY);
  store.removeItem(CREDENTIAL_KEY);
}

export function randomId(api: BrowserCrypto = crypto): string {
  if (api.randomUUID) return api.randomUUID();
  const bytes = api.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; }
    catch { /* Try the browser's selection-based copy when the async API is unavailable. */ }
  }
  const focused = document.activeElement as HTMLElement | null;
  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.tabIndex = -1;
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(field);
  try {
    field.select();
    field.setSelectionRange(0, value.length);
    if (!document.execCommand("copy")) throw new Error("clipboard-unavailable");
  } finally { field.remove(); focused?.focus({ preventScroll: true }); }
}
