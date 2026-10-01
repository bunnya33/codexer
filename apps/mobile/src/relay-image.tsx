import { Image } from 'react-native';
import type { ImageProps } from 'react-native';

export type RemoteImageSource = { uri: string; headers?: Record<string, string> };
export function RelayImage(props: Omit<ImageProps, 'source'> & { source: RemoteImageSource }) { return <Image {...props} />; }
