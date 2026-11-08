import { defaultPreviewPreferences } from "./review-fixtures";
import type { PreviewPreferences } from "./review-fixtures";
export function readPreviewPreferences(): PreviewPreferences {
  return defaultPreviewPreferences;
}
export function savePreviewPreferences(_value: PreviewPreferences) {}
