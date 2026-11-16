import { Image, Platform } from 'react-native';
import type { ImageProps } from 'react-native';

export type RemoteImageSource = { uri: string; headers?: Record<string, string> };
export function RelayImage({source, ...props}: Omit<ImageProps, 'source'> & { source: RemoteImageSource }) {
  // RN 0.86 Android forwards headers only from the array-source branch.
  return <Image {...props} source={Platform.OS === 'android' ? [source] : source} />;
}
