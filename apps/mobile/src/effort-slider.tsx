import Slider from '@react-native-community/slider';
import type { EffortSliderProps } from './effort-slider.types';

export function EffortSlider({ labels, value, disabled, onChange, onCommit }: EffortSliderProps) {
  return <Slider accessibilityLabel="推理强度" accessibilityValue={{ min: 0, max: labels.length - 1, now: value, text: labels[value] }}
    value={value} minimumValue={0} maximumValue={Math.max(1, labels.length - 1)} step={1} disabled={disabled || labels.length < 2}
    onValueChange={onChange} onSlidingComplete={onCommit} minimumTrackTintColor="#2d88d4" maximumTrackTintColor="#e9e9eb" thumbTintColor="#fff"
    style={{ width: '100%', height: 48 }} />;
}
