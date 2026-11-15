import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { documentPreviewHTML, documentPreviewSource, readDocumentPDF } from '../../../packages/client-shared/src/document-preview';
import type { PreviewFileInfo } from '../../../packages/client-shared/src/file-preview';
import { fileError, fileResponse, type FileSource } from './file-transfer';
import { PreviewSurface } from './preview-surface';
import type { PreviewSurfaceHandle } from './preview-surface.types';
import { useTheme } from './styles';

export function FileDocument({ source, info }: { source: FileSource; info: PreviewFileInfo }) {
  const { c } = useTheme();
  const viewport = useWindowDimensions();
  const [channel] = useState(() => 'document-' + Math.random().toString(36).slice(2));
  const [document, setDocument] = useState<string>(), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const surface = useRef<PreviewSurfaceHandle>(null);
  useEffect(() => {
    const controller = new AbortController();
    setDocument(undefined); setError('');
    void (async () => {
      const response = await fileResponse(documentPreviewSource(source), controller.signal);
      const bytes = await readDocumentPDF(response, info);
      if (!controller.signal.aborted) setDocument(documentPreviewHTML(bytes, source.uri, channel));
    })().catch(failure => {
      if (!controller.signal.aborted) setError(fileError(failure instanceof Error && failure.message === 'HTTP 404' ? new Error('document-server-update-required') : failure));
    });
    return () => controller.abort();
  }, [source.uri, source.headers.authorization, info.version, revision, channel]);
  return document ? <PreviewSurface document={document} channel={channel} expanded height={viewport.height} title={`${info.name} 文档预览`} kind="document" surfaceRef={surface} onMessage={() => {}} />
    : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 }}>
      {!error && <ActivityIndicator color={c.accent} />}
      <Text accessibilityRole={error ? 'alert' : undefined} style={{ color: error ? c.danger : c.muted, fontSize: 14, lineHeight: 23 }}>{error || '正在读取 PDF…'}</Text>
      {!!error && <Pressable accessibilityRole="button" accessibilityLabel="重试文档预览" onPress={() => setRevision(value => value + 1)} style={{ padding: 12 }}><Text style={{ color: c.accent }}>重试预览</Text></Pressable>}
    </View>;
}
