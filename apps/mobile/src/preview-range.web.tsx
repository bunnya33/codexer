import { useTheme } from './styles';
export function PreviewRange({ value, min, max, step, label, onChange }: { value: number; min: number; max: number; step: number; label: string; onChange: (value: number) => void }) {
  const { c } = useTheme();
  return <input aria-label={label} type="range" value={value} min={min} max={max} step={step} onChange={event => onChange(Number(event.target.value))} style={{ width: '100%', accentColor: c.accent }} />;
}
