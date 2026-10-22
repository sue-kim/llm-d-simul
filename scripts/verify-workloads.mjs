import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const base = process.env.SIMULATOR_URL || 'http://127.0.0.1:8787';
const { defaults } = await (await fetch(`${base}/api/health`)).json();
const post = async config => {
  const response = await fetch(`${base}/api/compare`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});
  const body = await response.json();
  assert.equal(response.status, 200, body.error);
  return body;
};
const key = e => e.sessionId ? `${e.sessionId}/turn/${e.roundIndex}` : e.requestId;
const arrivals = side => new Map(side.playback.events.filter(e => e.kind === 'arrived').map(e => [key(e), e]));
const agents = await post({...defaults, workload:'agents', sessions:16, turns:4, inputTokens:256, outputTokens:256, prefixTokens:1024});
assert.equal(agents.fairness.mode, 'matched-sessions');
assert.equal(agents.fairness.matchedRequests, 64);
const a = arrivals(agents.basic), b = arrivals(agents.llmd);
let differentArrival = false, differentRawId = false;
for (const [id, e] of a) {
  const other = b.get(id);
  assert.ok(other);
  assert.equal(e.inputHash, other.inputHash);
  assert.equal(e.outputHash, other.outputHash);
  assert.equal(e.inputTokens, other.inputTokens);
  if (e.roundIndex === 0) assert.equal(e.timeUs, other.timeUs);
  else {
    differentArrival ||= e.timeUs !== other.timeUs;
    differentRawId ||= e.requestId !== other.requestId;
  }
}
assert.ok(differentArrival, 'fixture should exercise response-dependent arrivals');
assert.ok(differentRawId, 'fixture should exercise matching across completion-order IDs');
for (const policy of ['basic', 'llmd']) {
  const side = agents[policy], requests = arrivals(side);
  assert.equal(side.metrics.completed_requests, 64);
  assert.equal(side.metrics.failed_requests, 0);
  const sessions = new Map();
  for (const [id, e] of requests) {
    const history = side.playback.events.filter(event => key(event) === id);
    assert.ok(history.some(event => event.kind === 'completed'));
    const metric = side.metrics.requests.find(r => r.requestID === e.requestId);
    assert.ok(metric, 'original IDs must resolve raw metrics');
    assert.equal(metric.num_decode_tokens, e.outputTokens);
    assert.equal(e.retainedOutputTokens, e.outputTokens - 1, 'pinned BLIS accumulation boundary');
    assert.ok(side.playback.decisions.Routings.some(r => r.RequestID === e.requestId));
    sessions.set(e.sessionId, (sessions.get(e.sessionId) ?? 0) + 1);
    if (e.roundIndex === 0) {
      assert.equal(e.historyTokens, agents.config.prefixTokens);
    } else {
      const previous = requests.get(`${e.sessionId}/turn/${e.roundIndex-1}`);
      const completed = side.playback.events.find(event => event.requestId === previous.requestId && event.kind === 'completed');
      assert.equal(e.timeUs, completed.timeUs + agents.config.thinkTimeMs * 1000);
      assert.equal(e.historyTokens, previous.inputTokens + previous.retainedOutputTokens);
      assert.equal(e.historyHash, previous.contextHash, 'retained context includes the previous output');
    }
    const newInput = e.inputTokens - e.historyTokens;
    assert.ok(newInput >= 16 && newInput <= 2 * agents.config.inputTokens);
  }
  assert.equal(sessions.size, 16);
  assert.ok([...sessions.values()].every(turns => turns === 4));
  assert.equal(new Set([...requests.values()].filter(e => e.roundIndex === 0).map(e => e.historyHash)).size, 16, 'agents need independent initial contexts');
  const dir = path.join(root, '.runtime/runs', agents.id, policy);
  const manifest = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'));
  const args = [...manifest.args];
  args[args.indexOf('--metrics-path')+1] = path.join(dir, 'verify-metrics.json');
  args[args.indexOf('--trace-output')+1] = path.join(dir, 'verify-trace');
  const env = {...process.env}; delete env.BLIS_PLAYBACK_PATH;
  for (const observe of [false, true]) {
    if (observe) env.BLIS_PLAYBACK_PATH = path.join(dir, 'verify-playback.json');
    const run = spawnSync(path.join(root, '.runtime/bin/blis'), args, {cwd:manifest.workingDirectory, env, encoding:'utf8', maxBuffer:16*1024*1024, timeout:120000});
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'verify-metrics.json'), 'utf8')), side.metrics, 'observation must preserve agent metrics');
    if (observe) assert.deepEqual(JSON.parse(await readFile(env.BLIS_PLAYBACK_PATH, 'utf8')), side.playback, 'session playback must be reproducible');
  }
  console.log(`${policy}: 16 complete four-turn sessions; retained token content, causal arrivals, raw metric links, and deterministic inert observation verified.`);
}
const code = await post({...defaults, workload:'code', requests:64, rate:12, inputTokens:1024, outputTokens:2048, prefixTokens:2048});
assert.equal(code.fairness.mode, 'identical-arrivals');
assert.equal(code.identicalInputs, true);
for (const policy of ['basic', 'llmd']) {
  const side = code[policy];
  assert.equal(side.metrics.completed_requests, 64);
  assert.equal(side.metrics.failed_requests, 0);
  assert.ok(side.metrics.total_output_tokens > 64*1500, 'code preset must exercise long outputs');
}
const invalid = await fetch(`${base}/api/compare`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...agents.config, turns:8, inputTokens:8192})});
assert.equal(invalid.status, 400, 'context truncation must be refused before simulation');
await writeFile(path.join(root, '.runtime/workloads-result.json'), JSON.stringify({agents:agents.id, code:code.id, passed:true},null,2));
console.log('Long-output code generation completes on both policies; unsafe accumulated context is refused.');
