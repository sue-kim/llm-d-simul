import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const base = process.env.SIMULATOR_URL || 'http://127.0.0.1:8787';
const config = { workload:'chat',model:'llama-3.1-8b-instruct',hardware:'h100',instances:4,requests:64,rate:120,inputTokens:256,outputTokens:128,prefixTokens:512,seed:19 };
const post = async c => {
  const response = await fetch(`${base}/api/compare`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)});
  const body = await response.json();
  assert.equal(response.status,200,body.error);
  return body;
};
const result = await post(config);
assert.equal(result.identicalInputs,true);
for (const policy of ['basic','llmd']) {
  const side = result[policy];
  const events = side.playback.events;
  assert.equal(side.metrics.completed_requests,config.requests);
  assert.equal(side.metrics.failed_requests,0);
  assert.equal(side.metrics.still_queued+side.metrics.still_running,0);
  for (let i=1;i<events.length;i++) assert.ok(events[i].timeUs>=events[i-1].timeUs,'event clock went backwards');
  const requests = new Map();
  for (const e of events) { if(!requests.has(e.requestId)) requests.set(e.requestId,[]);requests.get(e.requestId).push(e); }
  assert.equal(requests.size,config.requests);
  for (const [id,history] of requests) {
    assert.deepEqual(history.map(e=>e.kind),['arrived','routed','queued','processing','streaming','completed'],`lifecycle: ${id}`);
    const metric=side.metrics.requests.find(r=>r.requestID===id);
    assert.ok(metric,`missing request metric: ${id}`);
    const observedTTFT=(history.find(e=>e.kind==='streaming').timeUs-history[0].timeUs)/1000;
    assert.ok(Math.abs(observedTTFT-metric.ttft_ms)<0.000001,'first token timestamp differs from BLIS metrics');
    assert.equal(history[1].instanceId,metric.handled_by);
  }
  const dir=path.join(root,'.runtime/runs',result.id,policy);
  const manifest=JSON.parse(await readFile(path.join(dir,'run.json'),'utf8'));
  const args=[...manifest.args];
  args[args.indexOf('--metrics-path')+1]=path.join(dir,'verify-metrics.json');
  args[args.indexOf('--trace-output')+1]=path.join(dir,'verify-trace');
  // Run directly, bypassing the API cache: disabled observation must preserve metrics.
  const env={...process.env};delete env.BLIS_PLAYBACK_PATH;
  const unobserved=spawnSync(path.join(root,'.runtime/bin/blis'),args,{cwd:manifest.workingDirectory,env,encoding:'utf8',maxBuffer:16*1024*1024,timeout:120000});
  assert.equal(unobserved.status,0,unobserved.stderr);
  const unobservedMetrics=JSON.parse(await readFile(path.join(dir,'verify-metrics.json'),'utf8'));
  assert.deepEqual(unobservedMetrics,side.metrics,'instrumentation changed BLIS metrics');
  // A second instrumented run must reproduce every event and snapshot exactly.
  env.BLIS_PLAYBACK_PATH=path.join(dir,'verify-playback.json');
  const repeated=spawnSync(path.join(root,'.runtime/bin/blis'),args,{cwd:manifest.workingDirectory,env,encoding:'utf8',maxBuffer:16*1024*1024,timeout:120000});
  assert.equal(repeated.status,0,repeated.stderr);
  assert.deepEqual(JSON.parse(await readFile(env.BLIS_PLAYBACK_PATH,'utf8')),side.playback,'replay data is not deterministic');
  console.log(`${policy}: 64 requests accounted for; timing matches BLIS; observer is inert; repeated events and snapshots match.`);
}
const invalid=await fetch(`${base}/api/compare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...config,hardware:'unsupported'})});
assert.equal(invalid.status,400);
const summary=await post({...config,workload:'summarization',requests:32,inputTokens:4096,outputTokens:512,prefixTokens:0,rate:20});
for(const key of ['basic','llmd']) assert.equal(summary[key].metrics.completed_requests,32);
console.log('Summarization completes on both policies; unsupported hardware is refused.');
await writeFile(path.join(root,'.runtime/integration-result.json'),JSON.stringify({comparison:result.id,summarization:summary.id,passed:true},null,2));
