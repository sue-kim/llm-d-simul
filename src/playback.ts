import type { Event, Side, Snapshot, Stage } from './types';

const stageLabel: Record<Stage, string> = { arrived: 'Arrived', routed: 'Preparing input', queued: 'Queued', processing: 'Processing', streaming: 'Streaming', completed: 'Finished', preempted: 'Queued again', timed_out: 'Timed out', prefilling: 'Prefilling', kv_wait: 'Waiting for KV space', transferring: 'KV in transit', kv_transferred: 'KV received', decoding: 'Decoding', dropped: 'Dropped' };
export const eventLabel = (e: Event) => e.kind === 'queued' && e.phase ? `${e.phase === 'prefill' ? 'Prefill' : 'Decode'} queue` : stageLabel[e.kind];
export const instanceLabel = (id: string) => `Instance ${Number(id.match(/\d+$/)?.[0] ?? 0) + 1}`;

export const requestKey = (event: Event) => event.sessionId ? `${event.sessionId}/turn/${event.roundIndex}` : event.requestId;
export const requestLabel = (event: Event) => event.sessionId ? `Agent ${Number(event.clientId?.match(/\d+$/)?.[0] ?? 0) + 1} · Turn ${event.roundIndex + 1}` : event.requestId;

export function requestStates(events: Event[], time: number) {
  const states = new Map<string, Event>();
  for (const event of events) {
    if (event.timeUs > time) break;
    states.set(requestKey(event), event);
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

// Session duration includes inter-turn pauses and the final client-visible reply.
export function sessionDurations(side: Side) {
  const sessions = new Map<string, {start: number; end: number; turns: number}>();
  const completed = new Set(side.playback.events.filter(e => e.kind === 'completed').map(e => e.requestId));
  const metrics = new Map(side.metrics.requests.filter(r => completed.has(r.requestID)).map(r => [r.requestID, r]));
  for (const e of side.playback.events) {
    if (e.kind !== 'arrived' || !e.sessionId) continue;
    const metric = metrics.get(e.requestId);
    const previous = sessions.get(e.sessionId);
    sessions.set(e.sessionId, {
      start: Math.min(previous?.start ?? Infinity, e.timeUs / 1000),
      end: Math.max(previous?.end ?? 0, metric ? e.timeUs / 1000 + metric.e2e_ms : 0),
      turns: (previous?.turns ?? 0) + (metric ? 1 : 0),
    });
  }
  return sessions;
}
