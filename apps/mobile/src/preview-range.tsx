import Slider from '@react-native-community/slider';
export function PreviewRange({ value, min, max, step, label, onChange }: { value: number; min: number; max: number; step: number; label: string; onChange: (value: number) => void }) {
  return <Slider accessibilityLabel={label} value={value} minimumValue={min} maximumValue={max} step={step} onValueChange={onChange} minimumTrackTintColor="#147bb5" style={{ width: '100%', height: 40 }} />;
}
