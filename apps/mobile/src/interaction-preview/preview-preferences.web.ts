import { defaultPreviewPreferences, previewAccents } from "./review-fixtures";
import type { PreviewPreferences } from "./review-fixtures";
const key = "codexer-interaction-preview-v3-preferences";
export function readPreviewPreferences(): PreviewPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      value &&
      ["system", "light", "dark"].includes(value.appearance) &&
      Object.hasOwn(previewAccents, value.accent)
    )
      return { appearance: value.appearance, accent: value.accent };
  } catch {}
  return defaultPreviewPreferences;
}
export function savePreviewPreferences(value: PreviewPreferences) {
  localStorage.setItem(key, JSON.stringify(value));
}
