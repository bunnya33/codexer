import { Platform, useWindowDimensions } from 'react-native';

/** Use the desktop reader only when both the width and usable height allow it. */
export function useWideReader() {
  const { width, height } = useWindowDimensions();
  return ['web', 'windows', 'macos'].includes(Platform.OS) && width >= 900 && height >= 560;
}
