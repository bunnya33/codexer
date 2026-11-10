import type { ImagePickerAsset } from 'expo-image-picker';
import type { AttachmentAsset } from './attachment-picker';

export type MediaPickerOptions = { imageSlots: number; videoSlots: number };
export type MediaSelection = { images: ImagePickerAsset[]; videos: AttachmentAsset[] };
