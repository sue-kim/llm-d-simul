import type { Comparison, Event } from './types';
import { requestKey } from './playback.ts';

export const isQueued = (event: Event) => event.kind === 'queued' || event.kind === 'preempted';
export const isRunning = (event: Event) => ['processing', 'streaming', 'prefilling', 'decoding'].includes(event.kind);
export const comparisonStages = ['waiting', 'running', 'transferring', 'finished'] as const;
export type ComparisonStage = typeof comparisonStages[number];
type Counts = Record<ComparisonStage | 'failed' | 'received', number>;
type Point = { timeUs: number; basic: Counts; llmd: Counts };
export type PlaybackComparison = ReturnType<typeof buildPlaybackComparison>;
const emptyCounts = (): Counts => ({ waiting: 0, running: 0, transferring: 0, finished: 0, failed: 0, received: 0 });

function bucket(event: Event): keyof Counts | undefined {
  if (isQueued(event) || ['arrived', 'routed', 'kv_wait'].includes(event.kind)) return 'waiting';
  if (isRunning(event)) return 'running';
  if (event.kind === 'completed') return 'finished';
  if (event.kind === 'timed_out' || event.kind === 'dropped') return 'failed';
}

// Sweep recorded transitions once per run. Coalesce equal timestamps so temporary
// queue/transfer markers cannot create a gap that never existed in playback.
export function buildPlaybackComparison(result: Comparison) {
  type Change = { timeUs: number; policy: 'basic' | 'llmd'; event?: Event; transferDelta?: number };
  const changes: Change[] = [];
  for (const policy of ['basic', 'llmd'] as const) {
    for (const event of result[policy].playback.events) changes.push({ timeUs: event.timeUs, policy, event });
    for (const transfer of result[policy].playback.transfers ?? []) {
      changes.push({ timeUs: transfer.startUs, policy, transferDelta: 1 });
      changes.push({ timeUs: transfer.endUs, policy, transferDelta: -1 });
    }
  }
  changes.sort((a, b) => a.timeUs - b.timeUs);
  const states = { basic: new Map<string, Event>(), llmd: new Map<string, Event>() };
  const counts = { basic: emptyCounts(), llmd: emptyCounts() };
  const lanes = { basic: new Map<string, number>(), llmd: new Map<string, number>() };
  const points: Point[] = [{ timeUs: 0, basic: emptyCounts(), llmd: emptyCounts() }];
  const scale = emptyCounts();
  let instanceScale = 1;
  function updateLane(policy: 'basic' | 'llmd', event: Event, delta: number) {
    if (!event.instanceId || (!isQueued(event) && !isRunning(event))) return;
    const key = `${event.instanceId}/${isQueued(event) ? 'queue' : 'running'}`;
    lanes[policy].set(key, (lanes[policy].get(key) ?? 0) + delta);
  }
  for (let index = 0; index < changes.length;) {
    const timeUs = changes[index].timeUs;
    if (timeUs > result.endTimeUs) break;
    while (index < changes.length && changes[index].timeUs === timeUs) {
      const { policy, event, transferDelta } = changes[index++];
      if (event) {
        const key = requestKey(event), previous = states[policy].get(key);
        if (previous) {
          const oldBucket = bucket(previous);
          if (oldBucket) counts[policy][oldBucket]--;
          updateLane(policy, previous, -1);
        } else counts[policy].received++;
        const nextBucket = bucket(event);
        if (nextBucket) counts[policy][nextBucket]++;
        updateLane(policy, event, 1);
        states[policy].set(key, event);
      }
      if (transferDelta) counts[policy].transferring += transferDelta;
    }
    const point = { timeUs, basic: { ...counts.basic }, llmd: { ...counts.llmd } };
    if (points.at(-1)?.timeUs === timeUs) points[points.length - 1] = point;
    else points.push(point);
    for (const policy of ['basic', 'llmd'] as const) {
      for (const stage of comparisonStages) scale[stage] = Math.max(scale[stage], counts[policy][stage]);
      for (const count of lanes[policy].values()) instanceScale = Math.max(instanceScale, count);
    }
  }
  let largestGap: { timeUs: number; stage: ComparisonStage; count: number } | undefined;
  let longestInterval = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index], nextTime = points[index + 1]?.timeUs ?? result.endTimeUs;
    const duration = nextTime - point.timeUs;
    if (duration <= 0) continue;
    // Prefer completion differences when equally large; either policy can lead.
    for (const stage of ['finished', 'waiting', 'running', 'transferring'] as const) {
      const count = Math.abs(point.llmd[stage] - point.basic[stage]);
      if (count > (largestGap?.count ?? 0) || (count > 0 && count === largestGap?.count && duration > longestInterval)) {
        largestGap = { timeUs: point.timeUs + duration / 2, stage, count };
        longestInterval = duration;
      }
    }
  }
  return { points, scale, instanceScale, largestGap };
}

export function comparisonAt(model: PlaybackComparison, time: number): Point {
  let low = 0, high = model.points.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (model.points[mid].timeUs <= time) low = mid;
    else high = mid - 1;
  }
  return model.points[low];
}
