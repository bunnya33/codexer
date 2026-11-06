import * as FileSystem from 'expo-file-system/legacy';

export type ConversationSelection = { deviceId: string; threadId: string };

const uri = () => FileSystem.documentDirectory + 'control-selections-v1.json';
let saved: Promise<Record<string, ConversationSelection>> | undefined;
let writes = Promise.resolve();

function selections() {
  return saved ??= (async () => {
    const values: Record<string, ConversationSelection> = Object.create(null);
    try {
      const data: unknown = JSON.parse(await FileSystem.readAsStringAsync(uri()));
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [scope, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && typeof value.deviceId === 'string' && value.deviceId && typeof value.threadId === 'string') {
            values[scope] = { deviceId: value.deviceId, threadId: value.threadId };
          }
        }
      }
    } catch { /* A missing or corrupt preference must not prevent login. */ }
    return values;
  })();
}

export async function readSelection(scope: string): Promise<ConversationSelection | null> {
  const value = (await selections())[scope];
  return value ? { ...value } : null;
}

export function saveSelection(scope: string, selection: ConversationSelection): Promise<void> {
  const value = { ...selection };
  // Keep account scopes and rapid device/thread choices in order on native storage.
  writes = writes.catch(() => {}).then(async () => {
    const values = await selections();
    if (value.deviceId) values[scope] = value;
    else delete values[scope];
    await FileSystem.writeAsStringAsync(uri(), JSON.stringify(values));
  });
  return writes;
}
