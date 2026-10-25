// Regression: cache affinity must not hide work waiting before engine admission.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';

const base = process.env.SIMULATOR_URL || 'http://127.0.0.1:8787';
const config = {
  workload:'chat', model:'llama-3.1-8b-instruct', hardware:'h100',
  instances:4, disaggregated:true, prefillInstances:2, fabric:'ib-400g',
  requests:256, rate:40, inputTokens:256, outputTokens:256, prefixTokens:512,
  seed:42, sessions:16, turns:4, thinkTimeMs:500, meanStartMs:1000,
};
const response = await fetch(`${base}/api/compare`, {
  method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(config),
});
const result = await response.json();
assert.equal(response.status, 200, result.error);
assert.deepEqual(result.config, config);
assert.equal(result.identicalInputs, true);
assert.equal(result.fairness.matchedRequests, config.requests);

const summary = {};
for (const policy of ['basic','llmd']) {
  const {metrics,playback} = result[policy];
  assert.equal(metrics.completed_requests, config.requests);
  assert.equal(metrics.failed_requests, 0);
  assert.equal(metrics.still_queued + metrics.still_running, 0);
  assert.equal(playback.transfers.length, config.requests);
  const distribution = {prefill:{instance_0:0,instance_1:0},decode:{instance_2:0,instance_3:0}};
  for (const transfer of playback.transfers) {
    assert.equal(playback.pools[transfer.prefillInstanceId], 'prefill');
    assert.equal(playback.pools[transfer.decodeInstanceId], 'decode');
    distribution.prefill[transfer.prefillInstanceId]++;
    distribution.decode[transfer.decodeInstanceId]++;
  }
  // This fixed, homogeneous workload must use both GPUs in each pool.
  // Allow unequal counts; balancing does not promise round-robin distribution.
  if (policy === 'llmd') {
    for (const counts of Object.values(distribution)) {
      assert.ok(Math.min(...Object.values(counts)) > config.requests * 0.2, 'pool remains concentrated on one endpoint');
    }
  }
  const arrivals = playback.events.filter(e => e.kind === 'arrived');
  const preparationMs = arrivals.reduce((sum,arrival) => {
    const queued = playback.events.find(e => e.requestId === arrival.requestId && e.kind === 'queued');
    assert.ok(queued);
    return sum + (queued.timeUs-arrival.timeUs)/1000;
  },0)/arrivals.length;
  summary[policy] = {distribution,preparationMeanMs:preparationMs,ttftMedianMs:metrics.ttft_p50_ms,ttftP95Ms:metrics.ttft_p95_ms,responseP95Ms:metrics.e2e_p95_ms};
}

const {playback} = result.llmd;
const [first,second] = playback.decisions.Routings;
const firstAdmission = playback.events.find(e => e.requestId === first.RequestID && e.kind === 'queued' && e.phase === 'prefill');
assert.ok(first.Clock < second.Clock && second.Clock < firstAdmission.timeUs, 'fixture must have a second dispatch before the first request enters the engine queue');
assert.ok(second.Candidates.every(c => c.QueueDepth === 0 && c.InFlightRequests === 0), 'engine metrics alone should still show idle endpoints');
assert.notEqual(second.ChosenInstance, first.ChosenInstance, 'decode routing must see the first dispatch before engine admission');
const prefills = new Map(playback.decisions.PrefillRoutings.map(r => [r.ParentRequestID,r.ChosenInstance]));
assert.notEqual(prefills.get(second.RequestID), prefills.get(first.RequestID), 'prefill routing must see the first dispatch before engine admission');

await writeFile('.runtime/routing-preset-result.json', JSON.stringify({passed:true,id:result.id,config,summary},null,2));
console.log(JSON.stringify({id:result.id,...summary},null,2));
console.log('Admission-wait visibility, pool distribution, matched inputs, and completion accounting passed.');
