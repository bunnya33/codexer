import type { HistoryTurn } from '../../../packages/protocol/src/index';

export type TurnTimingProps = { turn: HistoryTurn; kind: 'start' | 'end' };

// Preview this presentation in Web before adding it to installed native clients.
export function TurnTiming(_props: TurnTimingProps) { return null; }
