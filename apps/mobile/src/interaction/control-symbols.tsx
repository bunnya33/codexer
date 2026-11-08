import { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type { PermissionSettings } from '../../../../packages/protocol/src/index';
import { useTheme } from '../styles';
import { useControlTheme } from '../theme';
import { useInteractionMotion } from './motion';

export const chromePermissionLabels: Record<PermissionSettings['mode'], string> = {
  'read-only': '只读', ask: '请求批准', 'auto-review': '替我批准', 'full-access': '完全访问', custom: '自定义权限',
};
const shield = 'M12 2.5 20 6v6.6c0 4.3-3.1 7.3-8 9-4.9-1.7-8-4.7-8-9V6Z';

/** The upright hand and shield silhouettes in the supplied mobile reference. */
export function PermissionSymbol({ mode, size = 24 }: { mode: PermissionSettings['mode']; size?: number }) {
  const { c } = useTheme();
  const color = mode === 'full-access' ? '#e85d00' : c.text;
  return <Svg testID={`permission-symbol-${mode}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
    {mode === 'ask' ? <Path d="M7.5 12.6V5.8a1.45 1.45 0 0 1 2.9 0v5.6-7.6a1.45 1.45 0 0 1 2.9 0v7.6-6.3a1.45 1.45 0 0 1 2.9 0v6.7-4.5a1.4 1.4 0 0 1 2.8 0v7.8c0 4.6-2.5 7-6.5 7h-.7c-2.5 0-4.3-1.2-5.8-3.4L3.3 15a1.45 1.45 0 0 1 2.2-1.9l2 2.1v-2.6Z" />
      : mode === 'read-only' ? <><Path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><Circle cx="12" cy="12" r="2.7" /></>
        : <><Path d={shield} />{mode === 'auto-review' ? <Path d="m8.5 9 2.5 2.5L8.5 14M13.4 14h2.8" /> : mode === 'full-access' ? <><Path d="M12 8v5" /><Circle cx="12" cy="16.2" r=".85" fill={color} stroke="none" /></> : <><Circle cx="12" cy="12" r="3" /><Path d="M12 5v2m0 10v2M5 12h2m10 0h2" /></>}</>}
  </Svg>;
}

/** Each supported effort occupies a sector, so the third of six points straight up. */
export function effortProgress(index: number, count: number) { return count ? (Math.max(0, Math.min(count - 1, index)) + 1) / count : 0; }
const AnimatedPath = Animated.createAnimatedComponent(Path);

export function ReasoningGauge({ index, count, size = 25 }: { index: number; count: number; size?: number }) {
  const { c } = useTheme();
  const { theme } = useControlTheme();
  const motion = useInteractionMotion();
  const progress = effortProgress(index, count);
  const sector = useRef(new Animated.Value(progress)).current;
  useEffect(() => {
    const animation = Animated.timing(sector, { toValue: progress, duration: motion ? 140 : 0, useNativeDriver: false });
    animation.start(); return () => animation.stop();
  }, [sector, progress, motion]);
  const length = 10.2 * Math.PI * 1.5;
  return <Svg testID="reasoning-gauge" width={size} height={size} viewBox="0 0 26 26" fill="none" accessibilityLabel={count ? `推理强度 ${index + 1} / ${count}` : '模型设置'}>
    <Path d="M5.79 21.21a10.2 10.2 0 1 1 14.42 0" stroke={theme.dark ? '#69696c' : '#bfc0c0'} strokeWidth="1.9" strokeLinecap="round" />
    <AnimatedPath testID="reasoning-gauge-progress" d="M5.79 21.21a10.2 10.2 0 1 1 14.42 0" stroke={c.slider} strokeWidth="1.9" strokeLinecap="round" strokeDasharray={[length, length]} strokeDashoffset={sector.interpolate({ inputRange: [0, 1], outputRange: [length, 0] }) as unknown as number} />
    <AnimatedPath testID="reasoning-gauge-needle" d="M13 13.9V5.5" stroke={c.text} strokeWidth="1.9" strokeLinecap="round" origin="13,14" rotation={sector.interpolate({ inputRange: [0, 1], outputRange: [-135, 135] }) as unknown as number} />
    <Circle cx="13" cy="14" r="2.5" fill={c.composer} stroke={c.text} strokeWidth="1.9" />
  </Svg>;
}
