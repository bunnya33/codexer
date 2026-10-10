import type { Ref } from 'react';
export type PreviewSurfaceHandle = { send: (message: Record<string, unknown>) => void };
export type PreviewSurfaceProps = { document?: string; url?: string; channel: string; height: number; title: string; onMessage: (message: unknown) => void; surfaceRef: Ref<PreviewSurfaceHandle> };
