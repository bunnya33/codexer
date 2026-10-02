import { useEffect, useId, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, Text, View } from 'react-native';
import Svg, { ClipPath, Defs, LinearGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';

const Sweep = Animated.createAnimatedComponent(Rect);

export function ShimmerLabel({ text }: { text: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [width, setWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(true);
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) setReduceMotion(value); });
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { mounted = false; listener.remove(); };
  }, []);
  useEffect(() => {
    if (reduceMotion || !width) return;
    progress.setValue(0);
    const animation = Animated.loop(Animated.timing(progress, {toValue: 1, duration: 2000, easing: Easing.linear, useNativeDriver: false}));
    animation.start();
    return () => animation.stop();
  }, [progress, reduceMotion, width]);
  return <View testID="active-step-shimmer" style={{height: 18, flexShrink: 0}}>
    <Text onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{fontSize: 12, lineHeight: 18, color: '#9aa1a3'}}>{text}</Text>
    {!reduceMotion && width > 0 && <Svg pointerEvents="none" accessible={false} width={width} height={18} style={{position: 'absolute'}}>
      <Defs><ClipPath id={`${id}clip`}><SvgText x={0} y={13.2} fontSize={12} fontFamily={Platform.OS === 'ios' ? 'System' : 'Roboto'}>{text}</SvgText></ClipPath><LinearGradient id={`${id}gradient`}><Stop offset="0" stopColor="#56676d" stopOpacity={0} /><Stop offset="0.5" stopColor="#56676d" /><Stop offset="1" stopColor="#56676d" stopOpacity={0} /></LinearGradient></Defs>
      <Sweep x={progress.interpolate({inputRange: [0, 1], outputRange: [-40, width + 40]})} y={0} width={40} height={18} fill={`url(#${id}gradient)`} clipPath={`url(#${id}clip)`} />
    </Svg>}
  </View>;
}
