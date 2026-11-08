import { useEffect, useState } from 'react';
import { Platform, TextInput, useWindowDimensions } from 'react-native';
import type { TextInputProps } from 'react-native';
import type { ImagePickerAsset } from 'expo-image-picker';
import type { AttachmentAsset } from './attachment-picker';

export type ComposerProps = TextInputProps & { onImages: (assets: ImagePickerAsset[]) => void; imagesEnabled: boolean; onImageError: (message: string) => void; imageSlots?: number; onFiles?: (assets: AttachmentAsset[]) => void; filesEnabled?: boolean };
export function ComposerInput({ onImages: _onImages, imagesEnabled: _imagesEnabled, onImageError: _onImageError, imageSlots: _imageSlots, onFiles: _onFiles, filesEnabled: _filesEnabled, style, onContentSizeChange, ...props }: ComposerProps) {
  const {height: windowHeight} = useWindowDimensions();
  const maxHeight = windowHeight / 4;
  const minHeight = Math.min(42, maxHeight);
  const [contentHeight, setContentHeight] = useState(42);
  useEffect(() => { if (!props.value) setContentHeight(42); }, [props.value]);
  return <TextInput {...props} {...(Platform.OS === 'windows' ? {submitKeyEvents: [{code: 'Enter'}], blurOnSubmit: false} : {})} underlineColorAndroid="transparent" style={[style, {height: Math.min(Math.max(minHeight, contentHeight), maxHeight), minHeight, maxHeight}]} scrollEnabled={contentHeight > maxHeight} onContentSizeChange={event => {
    setContentHeight(Math.ceil(event.nativeEvent.contentSize.height));
    onContentSizeChange?.(event);
  }} />;
}
