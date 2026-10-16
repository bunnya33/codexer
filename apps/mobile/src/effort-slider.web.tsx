import type { CSSProperties } from 'react';
import type { EffortSliderProps } from './effort-slider.types';
import './effort-slider.web.css';

export function EffortSlider({ labels, value, disabled, onChange, onCommit }: EffortSliderProps) {
  return <div className="effort-slider" style={{ '--effort-progress': `${labels.length > 1 ? value / (labels.length - 1) * 100 : 0}%` } as CSSProperties}>
    <div className="effort-slider-dots" aria-hidden="true">{labels.map((label, index) => <span key={label} className={index <= value ? 'selected' : undefined} />)}</div>
    <input aria-label="推理强度" aria-valuetext={labels[value]} type="range" min={0} max={Math.max(1, labels.length - 1)} step={1} value={value} disabled={disabled || labels.length < 2}
      onChange={event => onChange(Number(event.target.value))}
      onPointerUp={event => onCommit(Number(event.currentTarget.value))}
      onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) onCommit(Number(event.currentTarget.value)); }}
      onBlur={event => onCommit(Number(event.currentTarget.value))} />
  </div>;
}
