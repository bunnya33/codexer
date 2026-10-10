import { localFilePath } from './file-links.js';
import { z } from 'zod';

export type PreviewReference = { kind: 'html' | 'server'; source: string; title: string; wide?: boolean };
export type PreviewPart = { kind: 'text'; text: string } | { kind: 'preview'; preview: PreviewReference };
export const MAX_PREVIEW_HTML_BYTES = 2 * 1024 * 1024;

/** Only explicit loopback hosts; DNS aliases, credentials and LAN addresses are excluded. */
export function localPreviewUrl(value: string): string | null {
  if (!/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function htmlPreviewPath(value: string): string | null {
  const path = localFilePath(value);
  return path && /\.html?$/i.test(path) ? path : null;
}

/** Preserve code examples literally, including quoted visualization instructions. */
export function splitPreviewContent(source: string): PreviewPart[] {
  const parts: PreviewPart[] = [];
  const pattern = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?:\n|$)|$)|`[^`\n]*`|visualize([^\n]+)|\[([^\]\n]+)\]\((?:<([^>\n]+)>|([^\s)]+))\)|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?![\w.:-])(?:[/?#][^\s<>\])，。]*)?/g;
  let end = 0;
  for (const match of source.matchAll(pattern)) {
    const at = match.index!;
    let preview: PreviewReference | undefined;
    if (match[2]) {
      try {
        const value = JSON.parse(match[2]) as { path?: unknown; title?: unknown; mode?: unknown };
        const path = typeof value.path === 'string' ? htmlPreviewPath(value.path) : null;
        if (path) preview = { kind: 'html', source: path, title: typeof value.title === 'string' ? value.title.slice(0, 160) : '交互预览', wide: value.mode === 'wide' };
      } catch { /* Incomplete streaming markers remain ordinary text. */ }
    } else if (!match[0].startsWith('`') && !match[0].startsWith('~')) {
      const link = match[4] ?? match[5] ?? match[0];
      const path = htmlPreviewPath(link), url = localPreviewUrl(link);
      if (path || url) preview = { kind: path ? 'html' : 'server', source: path ?? url!, title: match[3] ?? (path ? '网页预览' : '本地网页预览') };
    }
    if (!preview) continue;
    if (at > end) parts.push({ kind: 'text', text: source.slice(end, at) });
    parts.push({ kind: 'preview', preview });
    end = at + match[0].length;
  }
  if (end < source.length) parts.push({ kind: 'text', text: source.slice(end) });
  return parts;
}

export function previewReferences(source: string): PreviewReference[] {
  return splitPreviewContent(source).flatMap(part => part.kind === 'preview' ? [part.preview] : []);
}

export type WidgetState = { modelContent: unknown; privateContent: unknown };
export type TweakControl = { id: string; group: string; label: string; kind: 'slider' | 'toggle' | 'select' | 'color'; value: string | number | boolean; initial: string | number | boolean; min?: number; max?: number; step?: number; options?: { label: string; value: string }[] };
const scalar = z.union([z.string().max(1000), z.number().finite(), z.boolean()]);
const controlSchema = z.object({
  id: z.string().min(1).max(100), group: z.string().max(160), label: z.string().max(160), kind: z.enum(['slider', 'toggle', 'select', 'color']), value: scalar, initial: scalar,
  min: z.number().finite().optional(), max: z.number().finite().optional(), step: z.number().positive().finite().optional(),
  options: z.array(z.object({ label: z.string().max(160), value: z.string().max(1000) })).max(12).optional(),
}).refine(value => value.kind !== 'slider' || typeof value.value === 'number' && typeof value.min === 'number' && typeof value.max === 'number' && value.max >= value.min);
export function previewControls(value: unknown): TweakControl[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 72).flatMap(entry => {
    const parsed = controlSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) return [];
    seen.add(parsed.data.id); return [parsed.data];
  });
}

/** Saved values must still fit the controls exposed by a newer version of the page. */
export function restoredControlValue(control: TweakControl, value: unknown): string | number | boolean | undefined {
  if (control.kind === 'slider') return typeof value === 'number' && Number.isFinite(value) ? Math.max(control.min!, Math.min(control.max!, value)) : undefined;
  if (control.kind === 'toggle') return typeof value === 'boolean' ? value : undefined;
  if (control.kind === 'select') return typeof value === 'string' && control.options?.some(option => option.value === value) ? value : undefined;
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : undefined;
}
export type PreviewBridgeMessage = { type: 'height'; height: number } | { type: 'state'; id: string; state: WidgetState } | { type: 'controls'; controls: TweakControl[] } | { type: 'follow-up'; prompt: string; title?: string } | { type: 'ready' };

export function widgetState(value: unknown): WidgetState | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const state = { modelContent: record.modelContent ?? null, privateContent: record.privateContent ?? null };
    const json = JSON.stringify(state);
    return new TextEncoder().encode(json).length <= 16384 ? JSON.parse(json) as WidgetState : null;
  } catch { return null; }
}

/** Only model-visible state is included; private UI state never becomes a prompt. */
export function previewFeedback(reference: PreviewReference, note: string, state: WidgetState | null, controls: TweakControl[]): string {
  const changed = controls.filter(control => control.value !== control.initial).map(control => ({ group: control.group, label: control.label, before: control.initial, after: control.value }));
  return [`请按以下预览反馈修改内容：`, `预览：${reference.title}`, `来源：${reference.source}`, note.trim(), changed.length ? `参数调整：${JSON.stringify(changed)}` : '', state?.modelContent != null ? `当前交互选择：${JSON.stringify(state.modelContent)}` : ''].filter(Boolean).join('\n\n').slice(0, 30000);
}
