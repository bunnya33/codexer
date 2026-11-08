import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { InteractiveRequest } from '../../../packages/protocol/src/index';

type Answers = { page: number; text: Record<string, string>; choices: Record<string, number>; sent: string[]; submitted: boolean; pending: boolean; error: string };
function cell() {
  let value: Answers = { page: 0, text: {}, choices: {}, sent: [], submitted: false, pending: false, error: '' };
  let live = true;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (change: (previous: Answers) => Answers) => { if (live) { value = change(value); listeners.forEach(listener => listener()); } },
    dispose: () => { live = false; value = { ...value, text: {}, choices: {} }; listeners.clear(); },
  };
}
type Cell = ReturnType<typeof cell>;
const Drafts = createContext<Map<string, Cell> | undefined>(undefined);
const requestKey = (deviceId: string, threadId: string, request: InteractiveRequest) => JSON.stringify([deviceId, threadId, request.id, request.turnId, request.kind, request.details]);

/** Memory only: logout, account changes and resolved requests erase sensitive answers. */
export function RequestDraftProvider({ scope, deviceId, threadId, requests, children }: { scope: string; deviceId: string; threadId: string; requests?: InteractiveRequest[]; children: ReactNode }) {
  const drafts = useMemo(() => new Map<string, Cell>(), [scope]);
  useEffect(() => () => { drafts.forEach(draft => draft.dispose()); drafts.clear(); }, [drafts]);
  useEffect(() => {
    if (!requests) return; // An absent or resynchronizing snapshot does not mean the PC resolved the request.
    const active = new Set(requests.map(request => requestKey(deviceId, threadId, request)));
    for (const [key, draft] of drafts) {
      const identity = JSON.parse(key) as string[];
      if (identity[0] === deviceId && identity[1] === threadId && !active.has(key)) { draft.dispose(); drafts.delete(key); }
    }
  }, [drafts, deviceId, threadId, requests]);
  return <Drafts.Provider value={drafts}>{children}</Drafts.Provider>;
}

export function useRequestDraft(deviceId: string, threadId: string, request: InteractiveRequest) {
  const drafts = useContext(Drafts), key = requestKey(deviceId, threadId, request);
  const draft = useMemo(() => {
    if (!drafts) return cell();
    let stored = drafts.get(key);
    if (!stored) { stored = cell(); drafts.set(key, stored); }
    return stored;
  }, [drafts, key]);
  return [useSyncExternalStore(draft.subscribe, draft.get, draft.get), draft.update] as const;
}
