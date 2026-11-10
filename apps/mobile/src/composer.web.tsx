import { useCallback, useLayoutEffect, useRef } from 'react';
import { TextInput, useWindowDimensions } from 'react-native';
import type { ComposerProps } from './composer';
import { MAX_IMAGES } from '../../../packages/protocol/src/index';
import { isVideoAttachment } from '../../../packages/protocol/src/uploads';
import { attachmentFromFile } from './attachment-picker.web';
import { imageAsset } from './image-file.web';

export function ComposerInput({ onImages, imagesEnabled, onImageError, imageSlots = MAX_IMAGES, onFiles, filesEnabled, ...props }: ComposerProps) {
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
    // Read images one at a time so selecting twenty large photos does not
    // allocate twenty data URLs and decoded bitmaps at once.
    const photos = files.filter(file => file.type.startsWith('image/'));
    if (imagesEnabled && photos.length) {
      if (photos.length > imageSlots) onImageError(`最多还可添加 ${imageSlots} 张图片`);
      void (async () => { for (const file of photos.slice(0, imageSlots)) onImages([await imageAsset(file)]); })().catch(error => onImageError(error instanceof Error ? error.message : '无法读取图片'));
    }
    if (filesEnabled && onFiles) onFiles(files.filter(file => isVideoAttachment({ name: file.name, mimeType: file.type })).map(attachmentFromFile));
  };
  return <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
    onPaste={event => { const files = Array.from(event.clipboardData.files).filter(file => imagesEnabled && file.type.startsWith('image/') || filesEnabled && isVideoAttachment({ name: file.name, mimeType: file.type })); if (files.length) { event.preventDefault(); acceptFiles(files); } }}
    onDragOver={event => { if ((imagesEnabled || filesEnabled) && event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDrop={event => { if (!imagesEnabled && !filesEnabled) return; event.preventDefault(); acceptFiles(Array.from(event.dataTransfer.files)); }}>
    <TextInput {...props} ref={input} style={[props.style, {minHeight, maxHeight, outlineStyle: 'solid', outlineWidth: 0}]} />
  </div>;
}
