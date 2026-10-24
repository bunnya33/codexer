import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { GestureResponderEvent } from 'react-native';
import { useTheme } from './styles';
import type { EffortSliderProps } from './effort-slider.types';

const THUMB = 40;
export function EffortSlider({ labels, value, disabled, onChange, onCommit }: EffortSliderProps) {
  const { c } = useTheme();
  const [width, setWidth] = useState(0);
  const gesture = useRef<{ initial: number; current: number } | null>(null);
  const enabled = !disabled && labels.length > 1;
  const progress = labels.length > 1 ? value / (labels.length - 1) : 0;
  const pick = (event: GestureResponderEvent) => Math.max(0, Math.min(labels.length - 1,
    Math.round((event.nativeEvent.locationX - THUMB / 2) / Math.max(1, width - THUMB) * (labels.length - 1))));
  const change = (event: GestureResponderEvent) => {
    if (!enabled || !gesture.current) return;
    const next = pick(event);
    if (gesture.current.current !== next) { gesture.current.current = next; onChange(next); }
  };
  return <View accessibilityRole="adjustable" accessibilityLabel="推理强度" accessibilityState={{ disabled: !enabled }}
    accessibilityValue={{ min: 0, max: Math.max(0, labels.length - 1), now: value, text: labels[value] }}
    accessibilityActions={enabled ? [{ name: 'increment' }, { name: 'decrement' }] : []}
    onAccessibilityAction={event => {
      if (!enabled) return;
      const direction = event.nativeEvent.actionName === 'increment' ? 1 : event.nativeEvent.actionName === 'decrement' ? -1 : 0;
      const next = Math.max(0, Math.min(labels.length - 1, value + direction));
      if (next !== value) { onChange(next); onCommit(next); }
    }}
    onLayout={event => setWidth(event.nativeEvent.layout.width)}
    onStartShouldSetResponder={() => enabled}
    onResponderGrant={event => { gesture.current = { initial: value, current: value }; change(event); }}
    onResponderMove={change}
    onResponderRelease={event => {
      change(event);
      const current = gesture.current; gesture.current = null;
      if (enabled && current) onCommit(current.current);
    }}
    onResponderTerminationRequest={() => true}
    onResponderTerminate={() => { const current = gesture.current; gesture.current = null; if (current) onChange(current.initial); }}
    style={[styles.slider, !enabled && styles.disabled]}>
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.track, { backgroundColor: c.sliderTrack }]}>
      <View style={[styles.fill, { width: `${progress * 100}%`, backgroundColor: c.slider }]} />
      {labels.map((label, index) => <View key={label} style={[styles.dot, {
        left: THUMB / 2 + Math.max(0, width - THUMB) * (labels.length > 1 ? index / (labels.length - 1) : 0) - 3,
        backgroundColor: index <= value ? c.sliderSelectedDot : c.sliderDot,
      }]} />)}
    </View>
    <View pointerEvents="none" style={[styles.thumb, { left: Math.max(0, width - THUMB) * progress, backgroundColor: c.thumb, borderColor: c.thumbBorder }]} />
  </View>;
}

const styles = StyleSheet.create({
  slider: { height: THUMB, marginHorizontal: 4, marginTop: 10, marginBottom: 4 },
  track: { borderRadius: 22, overflow: 'hidden' }, fill: { height: '100%' },
  dot: { position: 'absolute', top: 17, width: 6, height: 6, borderRadius: 3 },
  thumb: { position: 'absolute', top: 0, width: THUMB, height: THUMB, borderRadius: THUMB / 2, borderWidth: 1,
    shadowColor: '#000', shadowOpacity: 0.12, shadowOffset: { width: 0, height: 1 }, shadowRadius: 3, elevation: 2 },
  disabled: { opacity: 0.5 },
});
