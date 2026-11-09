import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Animated, Easing, View } from "react-native";
import { useInteractionMotion } from "./motion";

export function Disclosure({ open, children }: { open: boolean; children: ReactNode }) {
  const motion = useInteractionMotion(),
    [mounted, setMounted] = useState(open),
    [measured, setMeasured] = useState(0);
  const height = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (open) setMounted(true);
    const animation = Animated.timing(height, {
      toValue: open ? measured : 0,
      duration: motion ? 240 : 0,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (finished && !open) setMounted(false);
    });
    return () => animation.stop();
  }, [open, measured, motion, height]);
  if (!mounted) return null;
  return (
    <Animated.View
      pointerEvents={open ? "auto" : "none"}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      style={{ height, overflow: "hidden" }}
    >
      <View onLayout={(e) => setMeasured(Math.ceil(e.nativeEvent.layout.height))}>{children}</View>
    </Animated.View>
  );
}
