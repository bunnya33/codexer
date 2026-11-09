import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, Pressable } from "react-native";
import { ArrowDown } from "lucide-react-native";
import { useTheme } from "../styles";
import { useInteractionMotion } from "./motion";

/** Keep the exit mounted; reversing a scroll reverses the current transition. */
export function JumpToBottom({ visible, onPress }: { visible: boolean; onPress: () => void }) {
  const { c, s } = useTheme(),
    motion = useInteractionMotion();
  const [present, setPresent] = useState(visible);
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  useEffect(() => {
    if (visible) setPresent(true);
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: motion ? (visible ? 220 : 160) : 0,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setPresent(false);
    });
    return () => animation.stop();
  }, [visible, motion, progress]);
  if (!present) return null;
  return (
    <Animated.View
      testID="jump-to-bottom-transition"
      pointerEvents={visible ? "box-none" : "none"}
      style={[
        s.jumpToBottom,
        {
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
            { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) },
          ],
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="滚动到会话底部"
        disabled={!visible}
        onPress={onPress}
        style={{ flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center" }}
      >
        <ArrowDown size={19} color={c.text} />
      </Pressable>
    </Animated.View>
  );
}
