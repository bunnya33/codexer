import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { View } from 'react-native';

function controls(panel: RefObject<View | null>) {
  const element = panel.current as unknown as HTMLElement | null;
  return Array.from(element?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[role="button"][tabindex="0"],[tabindex="0"]') ?? [])
    .filter(node => node.getClientRects().length > 0 && node.getAttribute('aria-disabled') !== 'true');
}

export function useSurfaceAccessibility(open: boolean, panel: RefObject<View | null>, close: () => void, focusKey?: string) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const items = controls(panel);
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === items.length - 1) {
        event.preventDefault(); (event.shiftKey ? items.at(-1) : items[0])?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      if (previous?.isConnected && !previous.closest('[aria-hidden="true"]')) previous.focus({ preventScroll: true });
    };
  }, [open, panel, close]);
  useEffect(() => {
    if (!open) return;
    const timer = requestAnimationFrame(() => controls(panel)[0]?.focus({ preventScroll: true }));
    const observer = new MutationObserver(() => {
      const element = panel.current as unknown as HTMLElement | null;
      if (element && !element.contains(document.activeElement)) controls(panel)[0]?.focus({ preventScroll: true });
    });
    if (panel.current) observer.observe(panel.current as unknown as HTMLElement, { childList: true, subtree: true });
    return () => { cancelAnimationFrame(timer); observer.disconnect(); };
  }, [open, panel, focusKey]);
}
