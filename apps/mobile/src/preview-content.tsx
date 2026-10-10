import { useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { splitPreviewContent } from '../../../packages/client-shared/src/previews';
import { PreviewContext } from './preview-context';
import { PreviewCard } from './preview-card';
export function PreviewContent({ source, renderText }: { source: string; renderText: (text: string) => ReactNode }) {
  const context = useContext(PreviewContext);
  const parts = useMemo(() => context ? splitPreviewContent(source) : [{ kind: 'text' as const, text: source }], [context, source]);
  return <View>{parts.map((part, index) => part.kind === 'text' ? <View key={index}>{renderText(part.text)}</View> : <PreviewCard key={part.preview.source + index} reference={part.preview} deviceId={context!.deviceId} threadId={context!.threadId} />)}</View>;
}
