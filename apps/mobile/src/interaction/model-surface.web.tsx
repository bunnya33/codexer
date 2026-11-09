import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import type { View } from 'react-native';
import { useControlTheme } from '../theme';
import { useInteractionMotion } from './motion';
import { useSurfaceAccessibility } from './surface-accessibility';
import './reference-controls.web.css';

export function ModelSurface({ open, host, anchor, composerAnchor, onClose, children }: {
  open: boolean; host: RefObject<View | null>; anchor: RefObject<View | null>; composerAnchor?: RefObject<View | null>; onClose: () => void; children: ReactNode;
}) {
  const { theme } = useControlTheme();
  const motion = useInteractionMotion();
  const [present, setPresent] = useState(open);
  const [geometry, setGeometry] = useState<{ left: number; top: number; width: number; originX: number; originY: number }>();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const close = useRef(() => closeRef.current()).current;
  useSurfaceAccessibility(open && present && !!geometry, panel as unknown as RefObject<View | null>, close, 'model');
  useEffect(() => {
    if (open) { setPresent(true); return; }
    const timer = setTimeout(() => setPresent(false), motion ? 230 : 0);
    return () => clearTimeout(timer);
  }, [open, motion]);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const h = (host.current as unknown as HTMLElement)?.getBoundingClientRect();
      const a = (anchor.current as unknown as HTMLElement)?.getBoundingClientRect();
      const composer = (composerAnchor?.current as unknown as HTMLElement)?.getBoundingClientRect();
      if (!h?.width || !a?.width) return;
      const width = Math.min(360, h.width - 32, Math.max(248, h.width * .82));
      const left = (h.width - width) / 2;
      const top = Math.max(10, Math.min(h.height - 122, (composer?.top ?? a.top) - h.top - 112 - 12));
      setGeometry({ left, top, width, originX: a.left - h.left - left, originY: a.top - h.top - top });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (host.current) observer.observe(host.current as unknown as Element);
    if (composerAnchor?.current) observer.observe(composerAnchor.current as unknown as Element);
    window.visualViewport?.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.visualViewport?.removeEventListener('resize', measure); };
  }, [open, host, anchor, composerAnchor]);
  if (!present || !geometry) return null;
  return <div className="reference-model-layer" aria-hidden={!open} data-state={open ? 'open' : 'closing'} data-motion={motion ? 'full' : 'reduced'} style={{ pointerEvents: open ? 'auto' : 'none' }}>
    <button aria-label="关闭模型面板" className="reference-model-dismiss" onClick={close} />
    <div className="reference-model-blur" style={{ top: Math.max(0, geometry.top - 130), background: theme.dark ? '#11111366' : '#ffffff77' }} />
    <div ref={panel} className="reference-model-panel" data-testid="model-morph-surface" role="dialog" aria-modal="true" aria-label="模型与推理强度"
      style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: 112, '--model-origin-x': `${geometry.originX}px`, '--model-origin-y': `${geometry.originY}px`, '--reference-rail-bg': theme.dark ? '#303033' : '#fff' } as CSSProperties}>
      {children}
    </div>
  </div>;
}
