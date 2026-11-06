import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, View } from 'react-native';
import { useTheme } from './styles';

export type TaskStatusDotProps = { running?: boolean; label?: string };

const ringStyle = { position: 'absolute' as const, top: 2, left: 2, width: 12, height: 12, borderRadius: 6, borderWidth: 1 };

function RunningRing({ color }: { color: string }) {
  const [reduceMotion, setReduceMotion] = useState(true);
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let mounted = true, changed = false;
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', value => { changed = true; setReduceMotion(value); });
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted && !changed) setReduceMotion(value); }).catch(() => {});
    return () => { mounted = false; listener.remove(); };
  }, []);
  useEffect(() => {
    progress.setValue(0);
    if (reduceMotion) return;
    const animation = Animated.loop(Animated.timing(progress, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: Platform.OS !== 'web' }));
    animation.start();
    return () => animation.stop();
  }, [progress, reduceMotion]);
  return <Animated.View style={[ringStyle, { borderColor: color, opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.65, 0] }), transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5] }) }] }]} />;
}

export function TaskStatusDot({ running = false, label }: TaskStatusDotProps) {
  const { c } = useTheme();
  const size = running ? 6 : 8;
  return <View testID="task-status-dot" accessible={!!label} accessibilityRole={label && running ? 'progressbar' : undefined} accessibilityLabel={label} accessibilityElementsHidden={!label} importantForAccessibility={label ? 'yes' : 'no-hide-descendants'} style={{ width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
    {running && <RunningRing color={c.taskRunning} />}
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: running ? c.taskRunning : c.success }} />
  </View>;
}
