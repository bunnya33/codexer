import { TextInput } from 'react-native';
import type { TextInputProps } from 'react-native';
import type { ImagePickerAsset } from 'expo-image-picker';

export type ComposerProps = TextInputProps & { onImages: (assets: ImagePickerAsset[]) => void; imagesEnabled: boolean; onImageError: (message: string) => void };
export function ComposerInput({ onImages: _onImages, imagesEnabled: _imagesEnabled, onImageError: _onImageError, ...props }: ComposerProps) { return <TextInput {...props} />; }
