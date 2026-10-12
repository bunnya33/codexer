export type ConversationSelection = { deviceId: string; threadId: string };

const key = (scope: string) => 'codexer.web.selection.v1:' + encodeURIComponent(scope);

export function readSelection(scope: string): ConversationSelection | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(scope)) ?? 'null');
    if (value && typeof value === 'object' && 'deviceId' in value && 'threadId' in value &&
        typeof value.deviceId === 'string' && value.deviceId && typeof value.threadId === 'string') {
      return { deviceId: value.deviceId, threadId: value.threadId };
    }
  } catch { /* Navigation still works if browser storage is unavailable or corrupt. */ }
  return null;
}

export function saveSelection(scope: string, selection: ConversationSelection): void {
  try {
    if (selection.deviceId) localStorage.setItem(key(scope), JSON.stringify(selection));
    else localStorage.removeItem(key(scope));
  } catch { /* Remembering navigation is optional. */ }
}
