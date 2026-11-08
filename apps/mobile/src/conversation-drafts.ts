import { useMemo, useReducer, useRef } from 'react';
import type { ImagePickerAsset } from 'expo-image-picker';
import type { AttachmentAsset } from './attachment-picker';
import type { PreparedPlan } from './plan-review';

export type DraftImage = { key: number; uri: string; name: string; asset?: ImagePickerAsset; id?: string; loading: boolean; error?: string };
export type DraftAttachment = { key: number; asset: AttachmentAsset; id?: string; loading: boolean; error?: string };
type ConversationDraft = { text: string; images: DraftImage[]; files: DraftAttachment[]; preparedPlan?: PreparedPlan };
type Change<T> = T | ((current: T) => T);
const empty: ConversationDraft = { text: '', images: [], files: [] };
const changed = <T,>(value: Change<T>, current: T): T => typeof value === 'function' ? (value as (current: T) => T)(current) : value;

/** In-memory drafts belong to the signed-in server/account and the exact device/thread pair. */
export function useConversationDraft(scope: string, deviceId: string, threadId: string) {
  const drafts = useMemo(() => new Map<string, ConversationDraft>(), [scope]);
  const currentDrafts = useRef(drafts);
  currentDrafts.current = drafts;
  const [, render] = useReducer(value => value + 1, 0);
  const key = JSON.stringify([deviceId, threadId]);
  // Captured setters keep uploads and send acknowledgements attached to their original conversation.
  // A logout/server/account change invalidates every outstanding callback, even after logging back in.
  const isCurrent = () => !!scope && !!deviceId && !!threadId && currentDrafts.current === drafts;
  const getDraft = () => drafts.get(key) ?? empty;
  const update = (change: (current: ConversationDraft) => ConversationDraft) => {
    if (!isCurrent()) return;
    const previous = getDraft(), next = change(previous);
    if (next === previous) return;
    if (next.text || next.images.length || next.files.length || next.preparedPlan) drafts.set(key, next);
    else drafts.delete(key);
    render();
  };
  return {
    draft: getDraft(), getDraft, isCurrent,
    setText: (value: Change<string>) => update(current => ({ ...current, text: changed(value, current.text) })),
    setImages: (value: Change<DraftImage[]>) => update(current => ({ ...current, images: changed(value, current.images) })),
    setFiles: (value: Change<DraftAttachment[]>) => update(current => ({ ...current, files: changed(value, current.files) })),
    preparePlan: (plan: PreparedPlan) => update(current => {
      if (current.preparedPlan?.turnId === plan.turnId && current.preparedPlan.itemId === plan.itemId && current.preparedPlan.text === plan.text) return current;
      const instruction = `请执行此会话中的“${plan.title}”方案（轮次 ${plan.turnId}，方案 ${plan.itemId}）。`;
      return { ...current, preparedPlan: plan, text: current.text.includes(instruction) ? current.text : [current.text, instruction].filter(Boolean).join('\n\n') };
    }),
    removePreparedPlan: () => update(current => ({ ...current, preparedPlan: undefined })),
    // Never clear newer edits made while the original submission was being acknowledged.
    clearSubmitted: (submitted: ConversationDraft) => update(current => current === submitted ? empty : current),
  };
}
