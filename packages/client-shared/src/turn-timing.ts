import type { HistoryTurn } from '../../protocol/src/index.js';

function recordedDate(value: number | undefined) {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function recordedTurnTiming(turn: HistoryTurn, running: boolean) {
  // Message, sync and render timestamps describe different events.
  const start = recordedDate(turn.startedAtMs);
  const end = running || turn.status === 'inProgress' ? undefined : recordedDate(turn.completedAtMs);
  return { start, end: end && (!start || end >= start) ? end : undefined };
}

export function localTaskTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
