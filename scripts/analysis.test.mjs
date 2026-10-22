import test from 'node:test';
import assert from 'node:assert/strict';
import {assessComparison,defaultTargets,queueIntervals,validTargets} from '../src/analysis.ts';

const e=(requestId,kind,timeUs,extra={})=>({requestId,kind,timeUs,inputTokens:100,outputTokens:50,roundIndex:0,...extra});
function side(policy, specs) {
  return {policy,metrics:{injected_requests:specs.length,completed_requests:specs.filter(s=>s.complete!==false).length,failed_requests:specs.filter(s=>s.failed).length,requests:specs.filter(s=>!s.missing).map(s=>({requestID:s.id,ttft_ms:s.ttft??100,e2e_ms:s.response??200}))},playback:{events:specs.flatMap(s=>[
    e(s.id,'arrived',s.arrival??0,s.meta), e(s.id,'queued',(s.arrival??0)+10000,{instanceId:'instance_0'}),
    e(s.id,'processing',(s.arrival??0)+20000,{instanceId:'instance_0'}),e(s.id,'streaming',(s.arrival??0)+(s.ttft??100)*1000),
    ...(s.complete===false?(s.failed?[e(s.id,'timed_out',300000)]:[]):[e(s.id,'completed',(s.arrival??0)+(s.response??200)*1000)])
  ]).sort((a,b)=>a.timeUs-b.timeUs),transfers:[]}};
}
function comparison(a,b,extra={}) {return {config:{workload:'chat',requests:a.metrics.injected_requests,disaggregated:false,...extra},basic:a,llmd:b};}
const analyze=(a,b,targets=defaultTargets,config={})=>assessComparison(comparison(a,b,config),targets);

test('inclusive limits, joint requirement, and failed/unfinished/unmeasured misses',()=>{
  const specs=[{id:'a',ttft:100,response:200},{id:'b',ttft:101,response:190},{id:'c',ttft:90,response:201},{id:'d',complete:false,failed:true},{id:'e',complete:false},{id:'f',missing:true}];
  const result=analyze(side('basic',specs),side('llmd',specs),{ttftMs:100,responseMs:200,requiredPercent:50});
  assert.equal(result.basic.firstTokenWithin,2);assert.equal(result.basic.responseWithin,2);
  assert.equal(result.basic.bothWithin,1);assert.equal(result.basic.total,6);
  assert.equal(result.basic.failed,1);assert.equal(result.basic.unfinished,1);assert.equal(result.basic.missingMeasurements,1);
  assert.equal(result.verdict,'neither');assert.equal(result.pairedCompleted,3);
});
test('verdicts use exact counts, update with targets, and allow either strategy to win',()=>{
  const a=side('basic',[{id:'a',ttft:100,response:200}]),b=side('llmd',[{id:'a',ttft:200,response:300}]);
  assert.equal(analyze(a,b,{ttftMs:100,responseMs:200,requiredPercent:100}).verdict,'basic-only');
  assert.equal(analyze(b,a,{ttftMs:100,responseMs:200,requiredPercent:100}).verdict,'llmd-only');
  assert.equal(analyze(a,b,{ttftMs:200,responseMs:300,requiredPercent:100}).verdict,'both');
  const few=side('basic',[{id:'a'},{id:'b'},{id:'c',complete:false}]);
  assert.equal(analyze(few,few,{...defaultTargets,requiredPercent:66.67}).basic.meets,false);
});
test('agent matching uses session/turn, independent of IDs and arrival time; un-emitted turns miss',()=>{
  const a=side('basic',[{id:'a',meta:{sessionId:'s',roundIndex:0}},{id:'b',arrival:1000000,meta:{sessionId:'s',roundIndex:1}}]);
  const b=side('llmd',[{id:'different',meta:{sessionId:'s',roundIndex:0}},{id:'other',arrival:1500000,ttft:150,meta:{sessionId:'s',roundIndex:1}}]);
  const result=analyze(a,b,defaultTargets,{workload:'agents',sessions:1,turns:3});
  assert.equal(result.pairedCompleted,2);assert.equal(result.basic.total,3);assert.equal(result.basic.unfinished,1);
  assert.equal(result.meanTTFTDeltaMs,25);
});
test('queue accounting clips at first token and handles repeated markers and preemption',()=>{
  const events=[e('a','queued',10),e('a','queued',15),e('a','processing',20),e('a','preempted',25),e('a','queued',27),e('a','processing',40),e('a','preempted',45)];
  assert.deepEqual(queueIntervals(events,35).map(i=>[i.startUs,i.endUs]),[[10,20],[25,35]]);
  assert.deepEqual(queueIntervals(events,50).map(i=>[i.startUs,i.endUs]),[[10,20],[25,40],[45,50]]);
});
function pdSide(policy, scale=1) {
  const id='parent', us=n=>n*1000*scale;
  return {policy,metrics:{injected_requests:1,completed_requests:1,failed_requests:0,requests:[{requestID:id,ttft_ms:100*scale,e2e_ms:200*scale}]},playback:{events:[
    e(id,'arrived',0),e(id,'queued',us(10),{phase:'prefill',instanceId:'instance_0'}),e(id,'prefilling',us(30),{phase:'prefill',instanceId:'instance_0'}),
    e(id,'kv_wait',us(50)),e(id,'transferring',us(60)),e(id,'kv_transferred',us(75)),e(id,'queued',us(75),{phase:'decode',instanceId:'instance_1'}),
    e(id,'decoding',us(90),{phase:'decode',instanceId:'instance_1'}),e(id,'streaming',us(100)),e(id,'completed',us(200))
  ],transfers:[{requestId:id,prefillInstanceId:'instance_0',decodeInstanceId:'instance_1',prefillCompleteUs:us(50),startUs:us(60),endUs:us(75),aloneUs:us(10)}]}};
}
test('PD phases sum to response time and split capacity wait, standalone cost and contention once',()=>{
  const result=analyze(pdSide('basic'),pdSide('llmd',2),defaultTargets,{disaggregated:true});
  const phases=Object.fromEntries(result.phases.map(p=>[p.phase,p]));
  assert.equal(phases.prefillQueue.basicMs,20);assert.equal(phases.kvSpace.basicMs,10);
  assert.equal(phases.transferBase.basicMs,10);assert.equal(phases.transferContention.basicMs,5);
  assert.equal(phases.decodeQueue.basicMs,15);assert.equal(phases.firstTokenWork.basicMs,30);
  assert.equal(result.phases.reduce((n,p)=>n+p.basicMs,0),200);assert.equal(result.phases.reduce((n,p)=>n+p.llmdMs,0),400);
  assert.equal(phases.transferContention.evidence.policy,'llmd');assert.equal(phases.transferContention.evidence.timeUs,135000);
  assert.equal(result.hotspots.find(h=>h.policy==='basic').instanceId,'instance_0');
});
test('incomplete phase records keep measured targets but do not fabricate attribution',()=>{
  const a=pdSide('basic'),b=pdSide('llmd');b.playback.transfers=[];
  const result=analyze(a,b,defaultTargets,{disaggregated:true});
  assert.equal(result.llmd.bothWithin,1);assert.equal(result.explainedRequests,0);assert.equal(result.excludedBreakdowns,1);assert.deepEqual(result.phases,[]);
});
test('invalid or absent latency and zero completions never produce a false pass',()=>{
  const specs=[{id:'a',ttft:NaN},{id:'b',response:-1},{id:'c',ttft:300,response:100}];
  const result=analyze(side('basic',specs),side('llmd',specs));
  assert.equal(result.basic.bothWithin,0);assert.equal(result.meanTTFTDeltaMs,null);assert.equal(result.verdict,'neither');
  assert.equal(validTargets({...defaultTargets,requiredPercent:0}),false);
  assert.equal(analyze(side('basic',[]),side('llmd',[]),{...defaultTargets,ttftMs:Infinity}),null);
  assert.equal(analyze(side('basic',[]),side('llmd',[])).basic.meets,false);
});
