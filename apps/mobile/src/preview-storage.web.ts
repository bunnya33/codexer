import type { WidgetState } from '../../../packages/client-shared/src/previews';
export type PreviewSnapshot = { state: WidgetState | null; tweaks: Record<string, string | number | boolean> };
export async function readPreviewState(key: string): Promise<PreviewSnapshot | null> {
  try { return JSON.parse(localStorage.getItem('codexer.preview.' + key) || 'null') as PreviewSnapshot | null; } catch { return null; }
}
export async function savePreviewState(key: string, value: PreviewSnapshot): Promise<void> {
  const serialized = JSON.stringify(value); if (serialized.length > 24000) throw new Error('预览状态过大');
  localStorage.setItem('codexer.preview.' + key, serialized);
}
