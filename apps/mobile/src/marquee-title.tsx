import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Platform, ScrollView, View } from 'react-native';
import { useTheme } from './styles';

export function MarqueeTitle({ text }: { text: string }) {
  const { s } = useTheme();
  const offset = useRef(new Animated.Value(0)).current;
  const [viewport, setViewport] = useState(0);
  const [content, setContent] = useState({ text, width: 0 });
  const [reduceMotion, setReduceMotion] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const distance = content.text === text ? Math.max(0, content.width - viewport) : 0;

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
      Animated.delay(1000),
      Animated.timing(offset, { toValue: -distance, duration: Math.max(1800, Math.round(distance / 30 * 1000)), easing: Easing.linear, useNativeDriver: Platform.OS !== 'web' }),
      Animated.delay(600),
      Animated.timing(offset, { toValue: 0, duration: 0, useNativeDriver: Platform.OS !== 'web' }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [text, viewport, distance, reduceMotion, foreground, offset]);

  return <View testID="conversation-title" accessible accessibilityLabel={text} style={{ flex: 1, minWidth: 0, overflow: 'hidden' }} onLayout={event => setViewport(event.nativeEvent.layout.width)}>
    <ScrollView horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false} pointerEvents="none" accessible={false}
      onContentSizeChange={width => setContent(current => current.text === text && current.width === width ? current : { text, width })}>
      <Animated.Text numberOfLines={1} style={[s.threadTitle, { flexShrink: 0, transform: [{ translateX: offset }] }]}>{text}</Animated.Text>
    </ScrollView>
  </View>;
}
