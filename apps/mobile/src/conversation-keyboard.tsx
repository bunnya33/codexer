import type { PropsWithChildren } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';

export function ConversationKeyboard({ children }: PropsWithChildren) {
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'android' ? 'height' : undefined}>{children}</KeyboardAvoidingView>;
}
