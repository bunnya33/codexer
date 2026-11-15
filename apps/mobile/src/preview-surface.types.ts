import type { Ref } from 'react';
export type PreviewSurfaceHandle = { send: (message: Record<string, unknown>) => void };
export type PreviewSurfaceProps = { document?: string; url?: string; channel: string; height: number; expanded?: boolean; title: string; kind?: 'document'; onMessage: (message: unknown) => void; surfaceRef: Ref<PreviewSurfaceHandle> };
