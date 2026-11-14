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
    // Do not collapse the focused editor: WebKit can lose caret scrolling while
    // wrapping. A hidden clone shares its typography and measures independently.
    const measuring = element.cloneNode(false) as HTMLTextAreaElement;
    measuring.removeAttribute('id');
    measuring.removeAttribute('aria-label');
    measuring.removeAttribute('data-testid');
    measuring.setAttribute('aria-hidden', 'true');
    measuring.tabIndex = -1;
    measuring.readOnly = true;
    Object.assign(measuring.style, { position: 'fixed', left: '-10000px', top: '0', height: '0', minHeight: '0', maxHeight: 'none', width: `${element.getBoundingClientRect().width}px`, visibility: 'hidden', overflow: 'hidden', pointerEvents: 'none' });
    measuring.value = element.value;
    element.parentElement?.appendChild(measuring);
    const computed = getComputedStyle(element);
    const contentHeight = measuring.scrollHeight + (parseFloat(computed.borderTopWidth) || 0) + (parseFloat(computed.borderBottomWidth) || 0);
    measuring.remove();
    element.style.height = `${Math.min(Math.max(minHeight, contentHeight), maxHeight)}px`;
    element.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
    if (contentHeight > maxHeight && element.ownerDocument.activeElement === element && element.selectionStart === element.value.length && element.selectionEnd === element.value.length) element.scrollTop = element.scrollHeight;
  }, [minHeight, maxHeight]);
  useLayoutEffect(measure, [measure, props.value]);
  useLayoutEffect(() => {
    const element = input.current as unknown as HTMLTextAreaElement | null;
    if (!element) return;
    let frame = 0;
    const changed = () => { measure(); cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    element.addEventListener('input', changed);
    element.addEventListener('compositionend', changed);
    return () => { cancelAnimationFrame(frame); element.removeEventListener('input', changed); element.removeEventListener('compositionend', changed); };
  }, [measure]);
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
