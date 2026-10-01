import { useCallback, useLayoutEffect, useRef } from 'react';
import { TextInput, useWindowDimensions } from 'react-native';
import type { ImagePickerAsset } from 'expo-image-picker';
import type { ComposerProps } from './composer';

async function imageAsset(file: File): Promise<ImagePickerAsset> {
  if (file.size > 32 * 1024 * 1024) throw new Error('所选图片超过 32 MB');
  const uri = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('无法读取图片')); reader.readAsDataURL(file); });
  const size = await new Promise<{ width: number; height: number }>((resolve, reject) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => reject(new Error('浏览器无法读取这张图片，请使用 PNG、JPEG 或 WebP')); image.src = uri; });
  return { uri, ...size, type: 'image', mimeType: file.type, fileName: file.name || 'image.png', base64: uri.slice(uri.indexOf(',') + 1), fileSize: file.size };
}
export function ComposerInput({ onImages, imagesEnabled, onImageError, ...props }: ComposerProps) {
  const input = useRef<TextInput>(null);
  const {height: windowHeight} = useWindowDimensions();
  const maxHeight = windowHeight / 4;
  const minHeight = Math.min(42, maxHeight);
  const measure = useCallback(() => {
    const element = input.current as unknown as HTMLTextAreaElement | null;
    if (!element) return;
    const scrollTop = element.scrollTop;
    // Measure the natural content height so deleting text can shrink the field too.
    element.style.height = '0px';
    const contentHeight = element.scrollHeight;
    element.style.height = `${Math.min(Math.max(minHeight, contentHeight), maxHeight)}px`;
    element.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
    element.scrollTop = contentHeight > maxHeight ? scrollTop : 0;
  }, [minHeight, maxHeight]);
  useLayoutEffect(measure, [measure, props.value]);
  useLayoutEffect(() => {
    const element = input.current as unknown as HTMLTextAreaElement | null;
    if (!element) return;
    let width = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      if (nextWidth !== width) { width = nextWidth; measure(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);
  const acceptFiles = (files: File[]) => {
    if (!imagesEnabled) return;
    void Promise.all(files.filter(file => file.type.startsWith('image/')).slice(0, 4).map(imageAsset)).then(onImages).catch(error => onImageError(error instanceof Error ? error.message : '无法读取图片'));
  };
  return <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
    onPaste={event => { const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (imagesEnabled && files.length) { event.preventDefault(); acceptFiles(files); } }}
    onDragOver={event => { if (imagesEnabled && event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDrop={event => { if (!imagesEnabled) return; event.preventDefault(); acceptFiles(Array.from(event.dataTransfer.files)); }}>
    <TextInput {...props} ref={input} style={[props.style, {minHeight, maxHeight, outlineStyle: 'solid', outlineWidth: 0}]} />
  </div>;
}
