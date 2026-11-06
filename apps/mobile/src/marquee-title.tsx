import { useEffect, useId, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Platform, ScrollView, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from './styles';

export function MarqueeTitle({ text }: { text: string }) {
  const { c, s } = useTheme();
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const offset = useRef(new Animated.Value(0)).current;
  const [viewport, setViewport] = useState(0);
  const [content, setContent] = useState({ text, width: 0 });
  const [reduceMotion, setReduceMotion] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const overflow = content.text === text && viewport > 0 ? Math.max(0, content.width - viewport) : 0;
  const overflowing = overflow > 1;
  const characterWidth = s.threadTitle.fontSize;
  const distance = overflowing ? overflow + characterWidth : 0;
  const fadeWidth = 16;

  useEffect(() => {
    let mounted = true, changed = false;
    const preference = AccessibilityInfo.addEventListener('reduceMotionChanged', value => { changed = true; setReduceMotion(value); });
    const state = AppState.addEventListener('change', value => setForeground(value === 'active'));
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted && !changed) setReduceMotion(value); }).catch(() => {});
    return () => { mounted = false; preference.remove(); state.remove(); };
  }, []);

  useEffect(() => {
    offset.setValue(0);
    if (reduceMotion || !foreground || viewport <= 0 || distance <= 1) return;
    const animation = Animated.loop(Animated.sequence([
      Animated.delay(2000),
      Animated.timing(offset, { toValue: -distance, duration: Math.max(1800, Math.round(distance / 30 * 1000)), easing: Easing.linear, useNativeDriver: Platform.OS !== 'web' }),
      Animated.delay(1000),
      Animated.timing(offset, { toValue: 0, duration: 0, useNativeDriver: Platform.OS !== 'web' }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [text, viewport, distance, reduceMotion, foreground, offset]);

  return <View testID="conversation-title" accessible accessibilityLabel={text} style={{ flex: 1, minWidth: 0, overflow: 'hidden' }} onLayout={event => setViewport(event.nativeEvent.layout.width)}>
    <ScrollView horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false} pointerEvents="none" accessible={false}
      onContentSizeChange={width => setContent(current => current.text === text && current.width === width ? current : { text, width })}>
      <Animated.Text testID="conversation-title-text" numberOfLines={1} style={[s.threadTitle, { flexShrink: 0, transform: [{ translateX: offset }] }]}>{text}</Animated.Text>
    </ScrollView>
    {overflowing && <>
      <Animated.View testID="title-fade-left" pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: fadeWidth, opacity: offset.interpolate({ inputRange: [-fadeWidth, 0], outputRange: [1, 0], extrapolate: 'clamp' }) }}>
        <Svg width="100%" height="100%" accessible={false}><Defs><LinearGradient id={`${id}left`} x1="0%" x2="100%" y1="0%" y2="0%"><Stop offset="0" stopColor={c.surface} /><Stop offset="1" stopColor={c.surface} stopOpacity={0} /></LinearGradient></Defs><Rect width="100%" height="100%" fill={`url(#${id}left)`} /></Svg>
      </Animated.View>
      <Animated.View testID="title-fade-right" pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: fadeWidth, opacity: offset.interpolate({ inputRange: [-distance, -overflow, 0], outputRange: [0, 1, 1], extrapolate: 'clamp' }) }}>
        <Svg width="100%" height="100%" accessible={false}><Defs><LinearGradient id={`${id}right`} x1="0%" x2="100%" y1="0%" y2="0%"><Stop offset="0" stopColor={c.surface} stopOpacity={0} /><Stop offset="1" stopColor={c.surface} /></LinearGradient></Defs><Rect width="100%" height="100%" fill={`url(#${id}right)`} /></Svg>
      </Animated.View>
    </>}
  </View>;
}
