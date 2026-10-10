import { createContext } from 'react';
export const PreviewContext = createContext<{ deviceId: string; threadId: string } | null>(null);
