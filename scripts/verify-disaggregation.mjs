// Critical integration checks: budget fairness, parent accounting, transfer timing,
// closed-loop causality, and observation that leaves BLIS's results unchanged.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const base = process.env.SIMULATOR_URL || 'http://127.0.0.1:8787';
const {defaults} = await (await fetch(`${base}/api/health`)).json();
const config = {...defaults, disaggregated:true, requests:16, inputTokens:2048, outputTokens:128};
const key = e => e.sessionId ? `${e.sessionId}/turn/${e.roundIndex}` : e.requestId;
async function run(overrides = {}) {
  const response = await fetch(`${base}/api/compare`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...config,...overrides})});
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  const count = result.config.workload === 'agents' ? result.config.sessions * result.config.turns : result.config.requests;
  const matched = new Map();
  for (const policy of ['basic','llmd']) {
    const {playback,metrics} = result[policy];
    const arrivals = playback.events.filter(e => e.kind === 'arrived');
    assert.equal(arrivals.length, count);
    assert.equal(new Set(arrivals.map(e => e.requestId)).size, count);
    assert.equal(Object.keys(playback.pools).length, result.config.instances);
    assert.equal(Object.values(playback.pools).filter(role => role === 'prefill').length, result.config.prefillInstances);
    assert.equal(Object.values(playback.pools).filter(role => role === 'decode').length, result.config.instances-result.config.prefillInstances);
    assert.equal(metrics.injected_requests, count);
    assert.equal(metrics.completed_requests, count);
    assert.equal(metrics.failed_requests, 0);
    assert.equal(playback.events.filter(e => e.kind === 'completed').length, count, 'count each parent once');
    assert.equal(playback.rawEvents.filter(e => e.kind === 'completed').length, 2*count, 'both engine child completions remain exported');
    assert.equal(playback.transfers.length, count);
    assert.equal(metrics.pd.transfers, count);
    assert.ok(playback.events.every(e => arrivals.some(a => a.requestId === e.requestId)), 'no child identities in normalized playback');
    const byKey = new Map(arrivals.map(e => [key(e),e]));
    for (const a of arrivals) {
      const events=playback.events.filter(e => e.requestId===a.requestId);
      const tr=playback.transfers.find(t => t.requestId===a.requestId);
      const raw=playback.decisions.KVTransfers.find(t => t.ParentRequestID===a.requestId);
      const metric=metrics.requests.find(r => r.requestID===a.requestId);
      assert.equal(playback.pools[tr.prefillInstanceId], 'prefill');
      assert.equal(playback.pools[tr.decodeInstanceId], 'decode');
      assert.equal(tr.startUs, raw.TransferStartTime);
      assert.equal(tr.endUs-tr.startUs, raw.TransferDuration);
      assert.equal(tr.pulledBlocks,raw.PulledKVBlocks);
      assert.ok(tr.startUs>=tr.prefillCompleteUs && tr.endUs>tr.startUs);
      assert.ok(tr.pulledBlocks<=tr.blocks);
      assert.equal(events.filter(e=>e.kind==='queued' && e.phase==='prefill').length, 1);
      assert.equal(events.filter(e=>e.kind==='queued' && e.phase==='decode').length, 1);
      assert.equal(events.find(e=>e.kind==='kv_wait').timeUs,tr.prefillCompleteUs);
      assert.equal(events.find(e=>e.kind==='transferring').timeUs,tr.startUs);
      assert.equal(events.find(e=>e.kind==='kv_transferred').timeUs,tr.endUs);
      assert.ok(events.find(e=>e.kind==='decoding').timeUs>=tr.endUs);
      assert.ok(Math.abs(events.find(e=>e.kind==='streaming').timeUs-a.timeUs-metric.ttft_ms*1000)<1);
      const mid=tr.startUs+(tr.endUs-tr.startUs)/2;
      assert.equal(events.filter(e=>e.timeUs<=mid).at(-1).kind,'transferring');
      assert.ok(events.find(e=>e.kind==='completed').timeUs>=events.find(e=>e.kind==='streaming').timeUs);
      if (a.sessionId && a.roundIndex>0) {
        const previous=byKey.get(`${a.sessionId}/turn/${a.roundIndex-1}`);
        const complete=playback.events.find(e=>e.requestId===previous.requestId && e.kind==='completed');
        assert.equal(a.timeUs,complete.timeUs+result.config.thinkTimeMs*1000);
        assert.equal(a.historyHash,previous.contextHash);
        assert.equal(a.historyTokens,previous.inputTokens+previous.retainedOutputTokens);
      }
      if (policy==='basic') matched.set(key(a),a);
      else {
        const other=matched.get(key(a));
        assert.equal(a.inputHash,other.inputHash);
        assert.equal(a.outputHash,other.outputHash);
        if (!a.sessionId || a.roundIndex===0) assert.equal(a.timeUs,other.timeUs);
      }
    }
  }
  console.log(`${result.config.workload}, ${result.config.model}/${result.config.hardware}, ${result.config.prefillInstances}+${result.config.instances-result.config.prefillInstances} GPUs, ${result.config.fabric}: ${count} matched parents, exact transfers, causal events.`);
  return result;
}

const chat=await run();
// Verify the observer neither changes numerical results nor introduces unstable playback.
for (const policy of ['basic','llmd']) {
  const dir=path.join(root,'.runtime/runs',chat.id,policy);
  const manifest=JSON.parse(await readFile(path.join(dir,'run.json'),'utf8'));
  const args=[...manifest.args];
  args[args.indexOf('--metrics-path')+1]=path.join(dir,'verify-pd-metrics.json');
  args[args.indexOf('--trace-output')+1]=path.join(dir,'verify-pd-trace');
  for (const observe of [false,true]) {
    const env={...process.env}; delete env.BLIS_PLAYBACK_PATH;
    if (observe) env.BLIS_PLAYBACK_PATH=path.join(dir,'verify-pd-playback.json');
    const run=spawnSync(path.join(root,'.runtime/bin/blis'),args,{cwd:manifest.workingDirectory,env,encoding:'utf8',maxBuffer:16*1024*1024,timeout:120000});
    assert.equal(run.status,0,run.stderr);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir,'verify-pd-metrics.json'),'utf8')),chat[policy].metrics);
    if (observe) assert.deepEqual(JSON.parse(await readFile(env.BLIS_PLAYBACK_PATH,'utf8')),chat[policy].playback);
  }
}
const code=await run({workload:'code',requests:64,rate:12,inputTokens:1024,outputTokens:2048,prefixTokens:2048,instances:5,prefillInstances:2,model:'qwen2.5-7b-instruct',hardware:'a100-80',fabric:'roce-200g'});
const agents=await run({workload:'agents',sessions:8,turns:4,inputTokens:256,outputTokens:128,prefixTokens:1024,thinkTimeMs:0,model:'qwen3-14b',hardware:'h200',instances:2,prefillInstances:1,fabric:'ethernet-100gbe'});
const summary=await run({workload:'summarization',inputTokens:4096,outputTokens:128,prefixTokens:0,instances:2,prefillInstances:1});
const slower=await run({...summary.config,fabric:'ethernet-100gbe'});
for (const policy of ['basic','llmd']) {
  const fast=summary[policy].playback.transfers.reduce((n,t)=>n+t.aloneUs,0);
  const slow=slower[policy].playback.transfers.reduce((n,t)=>n+t.aloneUs,0);
  assert.ok(slow>fast,'lower-bandwidth fabric must change modeled transfer costs');
}
for (const overrides of [{prefillInstances:0},{prefillInstances:4},{fabric:'unknown'}]) {
  const res=await fetch(`${base}/api/compare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...config,...overrides})});
  assert.equal(res.status,400,'invalid pools or fabric must be refused');
}
await writeFile('.runtime/disaggregation-result.json',JSON.stringify({passed:true,runs:[chat.id,code.id,agents.id,summary.id,slower.id]},null,2));
console.log('PD observation is inert and reproducible; all four workloads, three models/GPUs/networks, uneven/minimum budgets, zero-pause sessions, and bandwidth effects verified.');
