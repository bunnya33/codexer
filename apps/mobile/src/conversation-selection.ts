import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RelayView } from './relay';
import { readSelection, saveSelection } from './selection-storage';
import type { ConversationSelection } from './selection-storage';

const empty: ConversationSelection = { deviceId: '', threadId: '' };

export function useConversationSelection(view: RelayView) {
  const scope = view.userId ? JSON.stringify([view.url, view.userId]) : '';
  const remembered = useMemo(() => scope ? readSelection(scope) : null, [scope]);
  const [state, setState] = useState({ scope: '', selection: empty });
  const wanted = state.scope === scope ? state.selection : remembered ?? empty;

  // Resolve the pair together so a device switch cannot load another PC's thread.
  const deviceId = scope && view.devicesReady
    ? (view.devices.find(device => device.id === wanted.deviceId) ?? view.devices[0])?.id ?? ''
    : '';
  const catalog = view.catalogs[deviceId];
  const available = catalog?.threads.filter(thread => !thread.archived);
  const threadId = available?.find(thread => deviceId === wanted.deviceId && thread.id === wanted.threadId)?.id
    ?? available?.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id
    ?? '';
  const settled = !!scope && view.devicesReady && (!deviceId || !!catalog);

  useEffect(() => {
    if (!scope) { setState(current => current.scope ? { scope: '', selection: empty } : current); return; }
    // An empty list during initialization is not evidence that a saved item was removed.
    if (!settled) return;
    const selection = { deviceId, threadId };
    setState(current => current.scope === scope && current.selection.deviceId === deviceId && current.selection.threadId === threadId ? current : { scope, selection });
    saveSelection(scope, selection);
  }, [scope, settled, deviceId, threadId]);

  const selectDevice = useCallback((id: string) => {
    const selection = { deviceId: id, threadId: '' };
    setState({ scope, selection });
    if (scope) saveSelection(scope, selection);
  }, [scope]);
  const selectThread = useCallback((id: string) => {
    const selection = { deviceId, threadId: id };
    setState({ scope, selection });
    if (scope) saveSelection(scope, selection);
  }, [scope, deviceId]);
  return { deviceId, threadId, selectDevice, selectThread };
}
