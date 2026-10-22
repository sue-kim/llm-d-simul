import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const base = process.env.SIMULATOR_URL || 'http://127.0.0.1:8787';
const { defaults, deployments } = await (await fetch(`${base}/api/health`)).json();
assert.ok(deployments?.models.length > 1 && deployments.hardware.length > 1, 'selectors must offer multiple models and GPUs');
const results = [];
for (const model of deployments.models) {
  for (const hardwareId of model.hardwareIds) {
    const config = { ...defaults, model: model.id, hardware: hardwareId, instances: 2, requests: 16, rate: 80, inputTokens: 96, outputTokens: 32, prefixTokens: 64 };
    const response = await fetch(`${base}/api/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    assert.deepEqual(result.config, config);
    assert.equal(result.deployment.model.id, model.id);
    assert.equal(result.deployment.hardware.id, hardwareId);
    assert.equal(result.identicalInputs, true);
    const scenarios = [];
    const workloads = [];
    for (const policy of ['basic', 'llmd']) {
      const side = result[policy];
      assert.equal(side.metrics.completed_requests, config.requests, `${model.id}/${hardwareId}/${policy} completion`);
      assert.equal(side.metrics.failed_requests, 0);
      assert.equal(side.metrics.still_queued + side.metrics.still_running, 0);
      assert.ok(Number.isFinite(side.metrics.ttft_p95_ms) && side.metrics.ttft_p95_ms > 0);
      const arrivals = side.playback.events.filter(e => e.kind === 'arrived');
      assert.equal(arrivals.length, config.requests);
      assert.equal(side.playback.events.filter(e => e.kind === 'completed').length, config.requests);
      for (const snapshot of side.playback.snapshots) {
        assert.equal(snapshot.InstanceSnapshots.length, config.instances);
        for (const instance of snapshot.InstanceSnapshots) assert.equal(instance.Model, model.id);
      }
      const dir = path.join(root, '.runtime/runs', result.id, policy);
      const scenario = await readFile(path.join(dir, 'scenario.yaml'), 'utf8');
      assert.ok(scenario.includes(`model: ${model.id}\n`) && scenario.includes(`hardware: ${hardwareId}\n`));
      assert.ok(scenario.includes('gpus_per_node: 2\n') && scenario.includes('tp: 1'));
      scenarios.push(scenario);
      workloads.push(await readFile(path.join(dir, 'workload.yaml'), 'utf8'));
    }
    assert.equal(scenarios[0], scenarios[1], 'both policies must have identical deployments');
    assert.equal(workloads[0], workloads[1], 'both policies must have identical workloads');
    const row = { model: model.id, hardware: hardwareId, runId: result.id, basicTTFT: result.basic.metrics.ttft_p95_ms, llmdTTFT: result.llmd.metrics.ttft_p95_ms };
    results.push(row);
    console.log(`${model.label} / ${hardwareId}: both policies complete all 16 requests with matched settings.`);
  }
}
assert.equal(new Set(results.map(r => r.runId)).size, results.length, 'deployment selections must not share cached runs');
// Changing a selection must affect the real simulator, not only the labels.
for (const model of deployments.models) {
  assert.ok(new Set(results.filter(r => r.model === model.id).map(r => r.basicTTFT)).size > 1, 'GPU selection did not affect BLIS timing');
}
for (const hardware of deployments.hardware) {
  assert.ok(new Set(results.filter(r => r.hardware === hardware.id).map(r => r.basicTTFT)).size > 1, 'model selection did not affect BLIS timing');
}
const unsupported = await fetch(`${base}/api/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...defaults, model: 'llama-3.1-70b-instruct' }) });
assert.equal(unsupported.status, 400);
await writeFile(path.join(root, '.runtime/deployment-checks.json'), JSON.stringify({ passed: true, catalogCommit: deployments.catalogCommit, results }, null, 2));
console.log(`Verified ${results.length} deployment combinations; distinct caches and modeled timings; unsupported model rejected.`);
