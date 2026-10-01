import { clearWebCredentials, copyText, randomId, readWebCredentials, saveWebCredentials } from '../../../packages/client-shared/src/browser';

export { copyText, randomId };
export const defaultRelayUrl = () => __DEV__ ? process.env.EXPO_PUBLIC_RELAY_URL || window.location.origin : window.location.origin;
export const readCredentials = async () => {
  const saved = readWebCredentials(undefined, 'control');
  if (!saved) return null;
  try {
    const value = JSON.parse(saved) as { url?: string };
    if (value.url && new URL(value.url).origin === new URL(defaultRelayUrl()).origin) return saved;
  } catch { /* Ignore invalid or obsolete connection settings. */ }
  clearWebCredentials(undefined, 'control');
  return null;
};
export const saveCredentials = async (value: string) => saveWebCredentials(value, undefined, 'control');
export const clearCredentials = async () => clearWebCredentials(undefined, 'control');
export const confirmAction = async (title: string, message: string) => window.confirm(`${title}\n\n${message}`);
