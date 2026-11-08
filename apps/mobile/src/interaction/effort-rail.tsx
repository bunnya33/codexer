import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { GestureResponderEvent } from 'react-native';
import type { EffortSliderProps } from '../effort-slider.types';
import { useTheme } from '../styles';

export type { EffortSliderProps } from '../effort-slider.types';
const HEIGHT = 48;

export function EffortRail({ labels, value, disabled, onChange, onCommit }: EffortSliderProps) {
  const { c } = useTheme();
  const [width, setWidth] = useState(0), [position, setPosition] = useState(value);
  const gesture = useRef<{ initial: number; current: number } | null>(null);
  const maximum = Math.max(1, labels.length - 1), enabled = !disabled && labels.length > 1;
  useEffect(() => { if (!gesture.current) setPosition(value); }, [value]);
  const progress = Math.max(0, Math.min(maximum, position)) / maximum;
  const update = (event: GestureResponderEvent) => {
    if (!enabled || !gesture.current) return;
    const next = Math.max(0, Math.min(maximum, (event.nativeEvent.locationX - HEIGHT / 2) / Math.max(1, width - HEIGHT) * maximum));
    const index = Math.round(next);
    setPosition(next);
    if (gesture.current.current !== index) { gesture.current.current = index; onChange(index); }
  };
  return <View testID="reference-effort-rail" accessibilityRole="adjustable" accessibilityLabel="推理强度" accessibilityState={{ disabled: !enabled }}
    accessibilityValue={{ min: 0, max: labels.length - 1, now: Math.round(position), text: labels[Math.round(position)] }}
    accessibilityActions={enabled ? [{ name: 'increment' }, { name: 'decrement' }] : []}
    onAccessibilityAction={event => {
      if (!enabled) return;
      const direction = event.nativeEvent.actionName === 'increment' ? 1 : event.nativeEvent.actionName === 'decrement' ? -1 : 0;
      const next = Math.max(0, Math.min(labels.length - 1, value + direction));
      if (next !== value) { setPosition(next); onChange(next); onCommit(next); }
    }}
    onLayout={event => setWidth(event.nativeEvent.layout.width)} onStartShouldSetResponder={() => enabled}
    onResponderGrant={event => { gesture.current = { initial: value, current: value }; update(event); }} onResponderMove={update}
    onResponderRelease={event => { update(event); const current = gesture.current; gesture.current = null; if (enabled && current) { setPosition(current.current); onCommit(current.current); } }}
    onResponderTerminationRequest={() => true}
    onResponderTerminate={() => { const current = gesture.current; gesture.current = null; if (current) { setPosition(current.initial); onChange(current.initial); } }}
    style={[styles.rail, { backgroundColor: c.surface, opacity: enabled ? 1 : .5 }]}>
    <View pointerEvents="none" style={[styles.fill, { width: HEIGHT + Math.max(0, width - HEIGHT) * progress, backgroundColor: c.slider }]} />
    {labels.map((label, index) => <View key={label} pointerEvents="none" style={[styles.tick, { left: HEIGHT / 2 - 6 + Math.max(0, width - HEIGHT) * index / maximum, backgroundColor: index <= Math.round(position) ? c.sliderSelectedDot : c.sliderDot }]} />)}
    <View pointerEvents="none" style={[styles.thumb, { left: 4 + Math.max(0, width - HEIGHT) * progress }]} />
  </View>;
}

const styles = StyleSheet.create({
  rail: { width: '100%', height: HEIGHT, borderRadius: 24, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, height: HEIGHT, borderRadius: 24 },
  tick: { position: 'absolute', top: 18, width: 12, height: 12, borderRadius: 6 },
  thumb: { position: 'absolute', top: 4, width: 40, height: 40, borderRadius: 20, backgroundColor: '#fff' },
});
