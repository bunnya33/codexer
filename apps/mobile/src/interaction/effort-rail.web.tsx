import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { EffortSliderProps } from '../effort-slider.types';
import './reference-controls.web.css';

/** The fill ends beyond the thumb, leaving the blue collar visible at every stop. */
export function EffortRail({ labels, value, disabled, onChange, onCommit }: EffortSliderProps) {
  const [position, setPosition] = useState(value);
  const dragging = useRef(false), initial = useRef(value);
  const maximum = Math.max(1, labels.length - 1);
  const enabled = !disabled && labels.length > 1;
  useEffect(() => { if (!dragging.current) setPosition(value); }, [value]);
  const commit = (next: number) => {
    const snapped = Math.max(0, Math.min(labels.length - 1, Math.round(next)));
    dragging.current = false; setPosition(snapped); onChange(snapped); onCommit(snapped);
  };
  return <div className="reference-effort-rail" data-testid="reference-effort-rail" style={{ '--rail-position': position / maximum } as CSSProperties}>
    <div className="reference-effort-fill" data-testid="reference-effort-fill" />
    <div className="reference-effort-ticks" aria-hidden="true">{labels.map((label, index) => <span key={label} className={index <= Math.round(position) ? 'selected' : ''} />)}</div>
    <div className="reference-effort-thumb" data-testid="reference-effort-thumb" />
    <input aria-label="推理强度" aria-valuetext={labels[Math.round(position)]} type="range" min={0} max={maximum} step="any" value={position} disabled={!enabled}
      onPointerDown={() => { initial.current = value; dragging.current = true; }}
      onChange={event => { const next = Number(event.target.value); setPosition(next); onChange(Math.round(next)); }}
      onPointerUp={event => commit(Number(event.currentTarget.value))}
      onPointerCancel={() => { dragging.current = false; setPosition(initial.current); onChange(initial.current); }}
      onBlur={event => { if (dragging.current) commit(Number(event.currentTarget.value)); }}
      onKeyDown={event => {
        const direction = ['ArrowRight', 'ArrowUp', 'PageUp'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowDown', 'PageDown'].includes(event.key) ? -1 : 0;
        if (!direction && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault(); commit(event.key === 'Home' ? 0 : event.key === 'End' ? maximum : position + direction);
      }} />
  </div>;
}
