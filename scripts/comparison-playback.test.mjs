import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlaybackComparison, comparisonAt } from '../src/comparisonPlayback.ts';

const event = (requestId, kind, timeUs, instanceId = 'instance_0', extra = {}) => ({ requestId, kind, timeUs, instanceId, roundIndex: 0, ...extra });
const side = (events, transfers = []) => ({ playback: { events: events.sort((a, b) => a.timeUs - b.timeUs), transfers } });
const comparison = (basic, llmd, endTimeUs = 100) => ({ basic, llmd, endTimeUs });

test('waiting includes preparation, admission, engine queues and KV-space wait; transfer ends are exclusive', () => {
  const basic = side([
    event('a', 'arrived', 0), event('a', 'routed', 1), event('a', 'queued', 10),
    event('a', 'prefilling', 20), event('a', 'kv_wait', 30), event('a', 'transferring', 40),
    event('a', 'kv_transferred', 50), event('a', 'queued', 50, 'instance_1'),
    event('a', 'decoding', 60, 'instance_1'), event('a', 'completed', 80),
    event('b', 'arrived', 0), event('b', 'dropped', 15),
  ], [{ startUs: 40, endUs: 50 }]);
  const model = buildPlaybackComparison(comparison(basic, basic));
  assert.equal(comparisonAt(model, 5).basic.waiting, 2);
  assert.equal(comparisonAt(model, 15).basic.failed, 1);
  assert.equal(comparisonAt(model, 25).basic.running, 1);
  assert.equal(comparisonAt(model, 35).basic.waiting, 1);
  assert.equal(comparisonAt(model, 45).basic.transferring, 1);
  assert.equal(comparisonAt(model, 50).basic.transferring, 0);
  assert.equal(comparisonAt(model, 50).basic.waiting, 1);
  assert.deepEqual(comparisonAt(model, 100).basic, { waiting: 0, running: 0, transferring: 0, finished: 1, failed: 1, received: 2 });
  assert.equal(model.largestGap, undefined);
});

test('same-timestamp queue transitions never create a fictitious gap or scale peak', () => {
  const a = side([event('a', 'arrived', 0), event('a', 'queued', 10), event('a', 'processing', 10), event('a', 'completed', 80)]);
  const b = side([event('b', 'arrived', 0), event('b', 'processing', 10), event('b', 'completed', 80)]);
  const model = buildPlaybackComparison(comparison(a, b));
  assert.equal(model.largestGap, undefined);
  assert.equal(model.points.filter(p => p.timeUs === 10).length, 1);
  assert.equal(comparisonAt(model, 10).basic.waiting, 0);
});

test('largest gap pauses inside a real interval and treats either policy identically', () => {
  const make = end => side(['a', 'b'].flatMap(id => [event(id, 'arrived', 0), event(id, 'processing', 10), event(id, 'completed', end)]));
  for (const [a, b] of [[30, 80], [80, 30]]) {
    const model = buildPlaybackComparison(comparison(make(a), make(b)));
    assert.equal(model.largestGap.count, 2);
    assert.equal(model.largestGap.stage, 'finished');
    assert.ok(model.largestGap.timeUs > 30 && model.largestGap.timeUs < 80);
    const point = comparisonAt(model, model.largestGap.timeUs);
    assert.equal(Math.abs(point.basic.finished - point.llmd.finished), 2);
    assert.equal(comparisonAt(model, 100).basic.finished, 2);
    assert.equal(comparisonAt(model, 100).llmd.finished, 2);
  }
});

test('instance scale includes every request beyond eight and is fixed across both sides', () => {
  const make = spread => side(Array.from({ length: 13 }, (_, i) => [event(`r${i}`, 'arrived', 0), event(`r${i}`, 'processing', 10, `instance_${spread ? i % 2 : 0}`), event(`r${i}`, 'completed', 80)]).flat());
  const model = buildPlaybackComparison(comparison(make(false), make(true)));
  assert.equal(model.instanceScale, 13);
  assert.equal(model.scale.running, 13);
  assert.equal(model.largestGap, undefined); // Placement differs; aggregate counts do not.
});

test('agent turns stay distinct when request IDs change across events', () => {
  const agent = side([
    event('a', 'arrived', 0, undefined, { sessionId: 'session-1', roundIndex: 0 }),
    event('a-child', 'processing', 10, undefined, { sessionId: 'session-1', roundIndex: 0 }),
    event('a', 'completed', 30, undefined, { sessionId: 'session-1', roundIndex: 0 }),
    event('b', 'arrived', 40, undefined, { sessionId: 'session-1', roundIndex: 1 }),
  ]);
  const model = buildPlaybackComparison(comparison(agent, agent));
  assert.equal(comparisonAt(model, 20).basic.received, 1);
  assert.equal(comparisonAt(model, 50).basic.received, 2);
  assert.equal(comparisonAt(model, 50).basic.finished, 1);
  assert.equal(comparisonAt(model, 50).basic.waiting, 1);
});
