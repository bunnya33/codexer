import { useEffect, useState } from 'react';
import type {RefObject} from 'react';
import { Platform, TextInput, useWindowDimensions } from 'react-native';
import type { TextInputProps } from 'react-native';
import type { ImagePickerAsset } from 'expo-image-picker';
import type { AttachmentAsset } from './attachment-picker';

export type ComposerProps = TextInputProps & { compact?:boolean; inputRef?:RefObject<TextInput|null>; onImages: (assets: ImagePickerAsset[]) => void; imagesEnabled: boolean; onImageError: (message: string) => void; imageSlots?: number; onFiles?: (assets: AttachmentAsset[]) => void; filesEnabled?: boolean };
export function ComposerInput({ compact=false, inputRef, onImages: _onImages, imagesEnabled: _imagesEnabled, onImageError: _onImageError, imageSlots: _imageSlots, onFiles: _onFiles, filesEnabled: _filesEnabled, style, onContentSizeChange, ...props }: ComposerProps) {
  const {height: windowHeight} = useWindowDimensions();
  const maxHeight = windowHeight / 4;
  const minimum = compact ? 28 : 42;
  const minHeight = Math.min(minimum, maxHeight);
  const empty = !props.value;
  const [contentHeight, setContentHeight] = useState(minimum);
  useEffect(() => { if (empty) setContentHeight(minHeight); }, [empty, minHeight]);
  // Fabric on iOS reports content size during layout. A fixed height can prevent
  // that layout from changing when text wraps, leaving the field stuck on one line.
  // Let nonempty iOS drafts size intrinsically. Pin an empty input to one line:
  // clearing a controlled UITextView can leave Fabric's previous intrinsic size
  // cached, even after the native keyboard has disappeared.
  const intrinsicHeight = Platform.OS === 'ios';
  return <TextInput ref={inputRef} {...props} {...(Platform.OS === 'windows' ? {submitKeyEvents: [{code: 'Enter'}], blurOnSubmit: false} : {})} underlineColorAndroid="transparent" style={[style, {height: empty ? minHeight : intrinsicHeight ? undefined : Math.min(Math.max(minHeight, contentHeight), maxHeight), minHeight, maxHeight}]} scrollEnabled={intrinsicHeight || !empty && contentHeight > maxHeight} onContentSizeChange={event => {
    const height = event.nativeEvent.contentSize.height;
    if (!empty && !intrinsicHeight && Number.isFinite(height)) setContentHeight(Math.ceil(height));
    onContentSizeChange?.(event);
  }} />;
}
