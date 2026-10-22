import type { Event, Side, Snapshot } from './types';

export function requestStates(events: Event[], time: number) {
  const states = new Map<string, Event>();
  for (const event of events) {
    if (event.timeUs > time) break;
    states.set(event.requestId, event);
  }
  return states;
}

export function snapshotAt(side: Side | undefined, time: number): Snapshot | undefined {
  const snapshots = side?.playback.snapshots ?? [];
  let low = 0, high = snapshots.length - 1, selected = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (snapshots[mid].Clock <= time) { selected = mid; low = mid + 1; } else high = mid - 1;
  }
  return snapshots[selected];
}

export const formatMs = (n?: number) => n == null || !Number.isFinite(n) ? '—' : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(1)} ms`;
export const formatNumber = (n?: number) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
