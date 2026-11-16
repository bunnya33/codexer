import { useCallback, useEffect, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { AppState, Keyboard, View } from 'react-native';
import type { KeyboardEvent, KeyboardMetrics } from 'react-native';

/** iOS can report another app's keyboard or a zero-origin transition frame
 * while switching apps. Never retain that displacement across a background. */
export function ConversationKeyboard({ children }: PropsWithChildren) {
  const host = useRef<View>(null);
  const phase = useRef(AppState.currentState);
  const keyboard = useRef<KeyboardMetrics | undefined>(Keyboard.metrics());
  const revision = useRef(0), frame = useRef<number | undefined>(undefined);
  const [bottom, setBottom] = useState(0);
  const measure = useCallback(() => {
    const current = ++revision.current;
    host.current?.measureInWindow((x, y, width, height) => {
      if (current !== revision.current || (phase.current && phase.current !== 'active')) return;
      const key = keyboard.current;
      const valid = key && [x, y, width, height, key.screenX, key.screenY, key.width, key.height].every(Number.isFinite)
        && width > 0 && height > 0 && key.height > 0 && key.screenY > 0
        && key.screenX <= x + 1 && key.screenX + key.width >= x + width - 1
        && key.screenY + key.height >= y + height - 1;
      // Floating/undocked keyboards should not move the whole conversation.
      setBottom(valid ? Math.min(key.height, Math.max(0, y + height - key.screenY)) : 0);
    });
  }, []);
  useEffect(() => {
    let live = true;
    const cancel = () => { revision.current++; if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; };
    const refresh = () => {
      cancel();
      frame.current = requestAnimationFrame(() => { frame.current = undefined; if (live) measure(); });
    };
    const change = (event: KeyboardEvent) => {
      if ((phase.current && phase.current !== 'active') || ('isEventFromThisApp' in event && event.isEventFromThisApp === false)) return;
      keyboard.current = event.endCoordinates; measure();
    };
    const hide = () => { keyboard.current = undefined; cancel(); setBottom(0); };
    const events = [
      Keyboard.addListener('keyboardWillShow', change), Keyboard.addListener('keyboardDidShow', change),
      Keyboard.addListener('keyboardWillChangeFrame', change), Keyboard.addListener('keyboardDidChangeFrame', change),
      Keyboard.addListener('keyboardWillHide', hide), Keyboard.addListener('keyboardDidHide', hide),
    ];
    const state = AppState.addEventListener('change', next => {
      phase.current = next;
      if (next === 'background') hide();
      else if (next === 'active') { keyboard.current = Keyboard.metrics(); refresh(); }
      else cancel();
    });
    refresh();
    return () => { live = false; cancel(); state.remove(); for (const event of events) event.remove(); };
  }, [measure]);
  return <View ref={host} collapsable={false} testID="conversation-keyboard" onLayout={measure} style={{ flex: 1, paddingBottom: bottom }}>{children}</View>;
}
