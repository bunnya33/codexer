import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Text, View } from 'react-native';
import type { ImageProps } from 'react-native';

export type RemoteImageSource = { uri: string; headers?: Record<string, string>; mimeType?: string; expectedBytes?: number };
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
      if (source.expectedBytes !== undefined && blob.size !== source.expectedBytes) throw new Error('invalid-image-response');
      if (!active) return;
      // 文件接口统一返回附件，按图片类型创建内存 Blob，SVG 也只在 img 中显示。
      objectUrl = URL.createObjectURL(source.mimeType ? new Blob([blob], { type: source.mimeType }) : blob);
      setValue({ uri: objectUrl, error: false });
    }).catch(() => { if (active) setValue({ uri: '', error: true }); });
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [source.uri, token, source.mimeType, source.expectedBytes]);
  return value;
}
export function RelayImage({ source, style, ...props }: Omit<ImageProps, 'source'> & { source: RemoteImageSource }) {
  const image = useImageUrl(source);
  return image.uri ? <Image {...props} style={style} source={{ uri: image.uri }} /> : <View style={[style, { alignItems: 'center', justifyContent: 'center' }]}>{image.error ? <Text>图片暂不可用</Text> : <ActivityIndicator />}</View>;
}
