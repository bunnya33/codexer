import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Text, View } from 'react-native';
import type { ImageProps } from 'react-native';

export type RemoteImageSource = { uri: string; headers?: Record<string, string> };
export function useImageUrl(source: RemoteImageSource) {
  const [value, setValue] = useState({ uri: '', error: false });
  const token = source.headers?.authorization;
  useEffect(() => {
    let active = true, objectUrl = '';
    const controller = new AbortController();
    setValue({ uri: '', error: false });
    void fetch(source.uri, { headers: source.headers, signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('image-unavailable');
      const blob = await response.blob();
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setValue({ uri: objectUrl, error: false });
    }).catch(() => { if (active) setValue({ uri: '', error: true }); });
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [source.uri, token]);
  return value;
}
export function RelayImage({ source, style, ...props }: Omit<ImageProps, 'source'> & { source: RemoteImageSource }) {
  const image = useImageUrl(source);
  return image.uri ? <Image {...props} style={style} source={{ uri: image.uri }} /> : <View style={[style, { alignItems: 'center', justifyContent: 'center' }]}>{image.error ? <Text>图片暂不可用</Text> : <ActivityIndicator />}</View>;
}
