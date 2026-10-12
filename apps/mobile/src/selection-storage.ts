export type ConversationSelection = { deviceId: string; threadId: string };

// Web remembers navigation in the browser; native navigation stays in memory.
export function readSelection(_scope: string): ConversationSelection | null { return null; }
export function saveSelection(_scope: string, _selection: ConversationSelection): void {}
