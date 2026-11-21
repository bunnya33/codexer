import type { MediaKind } from "../../../packages/client-shared/src/audio";

export type AudioPlayerProps = { kind: MediaKind; uri: string; onError: () => void; onEnded?: () => void };
