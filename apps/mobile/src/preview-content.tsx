import { useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { splitPreviewContent } from '../../../packages/client-shared/src/previews';
import { PreviewContext } from './preview-context';
import { PreviewCard } from './preview-card';
import { markdownReferenceSuffix, splitMediaContent } from '../../../packages/client-shared/src/audio';
import { InlineMedia } from './inline-audio';
export function PreviewContent({ source, renderText }: { source: string; renderText: (text: string) => ReactNode }) {
  const context = useContext(PreviewContext);
  const parts = useMemo(() => context ? splitPreviewContent(source) : [{ kind: 'text' as const, text: source }], [context, source]);
  const references = useMemo(() => context ? markdownReferenceSuffix(source) : '', [!!context, source]);
  return <View>{parts.map((part, index) => part.kind === 'text'
    ? <MediaContent key={index} source={part.text} referenceSource={source} references={references} renderText={renderText} />
    : <PreviewCard key={part.preview.source + index} reference={part.preview} deviceId={context!.deviceId} threadId={context!.threadId} />)}</View>;
}

function MediaContent({ source, referenceSource, references, renderText }: { source: string; referenceSource: string; references: string; renderText: (text: string) => ReactNode }) {
  const context = useContext(PreviewContext);
  const parts = useMemo(() => context ? splitMediaContent(source, referenceSource) : [{ kind: 'text' as const, text: source }], [!!context, source, referenceSource]);
  return <View>{parts.map((part, index) => part.kind === 'text'
    ? <View key={index}>{renderText(part.text + references)}</View>
    : <InlineMedia key={part.reference.source + index} kind={part.kind} reference={part.reference} deviceId={context!.deviceId} threadId={context!.threadId} />)}</View>;
}
