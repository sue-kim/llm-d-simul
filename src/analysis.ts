import type { Comparison, Event, Side } from './types';
import { requestKey } from './playback.ts';

export type LatencyTargets = { ttftMs: number; responseMs: number; requiredPercent: number };
export const defaultTargets: LatencyTargets = { ttftMs: 1000, responseMs: 10000, requiredPercent: 95 };
export const validTargets = (t: LatencyTargets) => Number.isFinite(t.ttftMs) && t.ttftMs >= 1 && t.ttftMs <= 3600000 && Number.isFinite(t.responseMs) && t.responseMs >= 1 && t.responseMs <= 3600000 && Number.isFinite(t.requiredPercent) && t.requiredPercent >= 1 && t.requiredPercent <= 100;

export type QueueInterval = {startUs: number; endUs: number; instanceId?: string; phase?: Event['phase']};
// A preemption opens another queue interval. Repeated queue markers do not reset it.
export function queueIntervals(events: Event[], throughUs = Infinity): QueueInterval[] {
  let start: Event | undefined;
  const intervals: QueueInterval[] = [];
  for (const e of events) {
    if (e.timeUs > throughUs) break;
    if ((e.kind === 'queued' || e.kind === 'preempted') && !start) start = e;
    if (start && ['processing','prefilling','decoding','completed','timed_out','dropped'].includes(e.kind)) {
      intervals.push({startUs:start.timeUs,endUs:e.timeUs,instanceId:start.instanceId,phase:start.phase});
      start = undefined;
    }
  }
  if (start && Number.isFinite(throughUs)) intervals.push({startUs:start.timeUs,endUs:throughUs,instanceId:start.instanceId,phase:start.phase});
  return intervals;
}

export const phaseLabels = {
  preparation: 'Input preparation + admission wait',
  engineQueue: 'Engine queue',
  prefillQueue: 'Prefill queue',
  kvSpace: 'Decode KV space wait',
  transferBase: 'KV transfer · standalone cost',
  transferContention: 'KV transfer · contention delay',
  decodeQueue: 'Decode queue',
  firstTokenWork: 'Prompt processing + first-token overhead',
  afterFirstToken: 'After first token',
} as const;
export type Phase = keyof typeof phaseLabels;
const queuePhases: Phase[] = ['engineQueue','prefillQueue','decodeQueue','kvSpace'];
const emptyPhases = (): Record<Phase,number> => ({preparation:0,engineQueue:0,prefillQueue:0,kvSpace:0,transferBase:0,transferContention:0,decodeQueue:0,firstTokenWork:0,afterFirstToken:0});

type RequestAnalysis = {
  key: string; requestId: string; arrival: Event; ttftMs: number; responseMs: number;
  phases: Record<Phase,number> | null; inspectAt: Partial<Record<Phase,number>>;
  queues: {phase: Phase; instanceId: string; ms: number}[];
};
export type TargetScore = {
  total: number; completed: number; measured: number; failed: number; unfinished: number;
  firstTokenWithin: number; responseWithin: number; bothWithin: number; percent: number;
  meets: boolean; missingMeasurements: number;
};
export type PhaseComparison = {phase: Phase; label: string; basicMs: number; llmdMs: number; deltaMs: number; evidence?: {key: string; policy: 'basic' | 'llmd'; timeUs: number; deltaMs: number}};
export type QueueHotspot = {policy: 'basic' | 'llmd'; phase: Phase; instanceId: string; requests: number; meanMs: number; totalMs: number};
export type Assessment = {
  version: 1; targets: LatencyTargets; basic: TargetScore; llmd: TargetScore;
  verdict: 'both' | 'llmd-only' | 'basic-only' | 'neither'; coverageDeltaPoints: number;
  pairedCompleted: number; explainedRequests: number; excludedBreakdowns: number;
  meanTTFTDeltaMs: number | null; meanResponseDeltaMs: number | null;
  phases: PhaseComparison[]; hotspots: QueueHotspot[];
};
const finiteLatency = (n: number) => Number.isFinite(n) && n >= 0;

function analyzeSide(side: Side, targets: LatencyTargets, planned: number, pd: boolean) {
  const histories = new Map<string, Event[]>();
  for (const event of side.playback.events) {
    const history = histories.get(event.requestId) ?? [];
    history.push(event); histories.set(event.requestId,history);
  }
  const metrics = new Map(side.metrics.requests.map(r => [r.requestID,r]));
  const transfers = new Map((side.playback.transfers ?? []).map(t => [t.requestId,t]));
  const measured = new Map<string,RequestAnalysis>();
  let completed=0, failedEvents=0, arrivals=0, firstTokenWithin=0, responseWithin=0, bothWithin=0;
  for (const [id,events] of histories) {
    const arrival=events.find(e=>e.kind==='arrived');
    if (!arrival) continue;
    arrivals++;
    const terminal=events.filter(e=>['completed','timed_out','dropped'].includes(e.kind)).at(-1);
    if (terminal?.kind==='timed_out' || terminal?.kind==='dropped') failedEvents++;
    if (terminal?.kind!=='completed') continue;
    completed++;
    const metric=metrics.get(id);
    if (!metric || !finiteLatency(metric.ttft_ms) || !finiteLatency(metric.e2e_ms) || metric.e2e_ms<metric.ttft_ms) continue;
    const ttft=metric.ttft_ms, response=metric.e2e_ms;
    const withinFirst=ttft<=targets.ttftMs, withinResponse=response<=targets.responseMs;
    firstTokenWithin+=Number(withinFirst); responseWithin+=Number(withinResponse); bothWithin+=Number(withinFirst && withinResponse);
    const firstUs=arrival.timeUs+ttft*1000;
    const phases=emptyPhases(), inspectAt: RequestAnalysis['inspectAt']={}, queues: RequestAnalysis['queues']=[];
    const firstQueue=events.find(e=>e.kind==='queued');
    let explainable=!!firstQueue && firstQueue.timeUs>=arrival.timeUs && firstQueue.timeUs<=firstUs;
    const clip=(start: number,end: number) => Math.max(0,Math.min(end,firstUs)-Math.max(start,arrival.timeUs))/1000;
    if (firstQueue) {
      phases.preparation=clip(arrival.timeUs,firstQueue.timeUs);
      inspectAt.preparation=(arrival.timeUs+firstQueue.timeUs)/2;
    }
    for (const interval of queueIntervals(events,firstUs)) {
      const phase=interval.phase==='prefill'?'prefillQueue':interval.phase==='decode'?'decodeQueue':'engineQueue';
      const ms=clip(interval.startUs,interval.endUs);
      phases[phase]+=ms;
      inspectAt[phase]=(interval.startUs+Math.min(interval.endUs,firstUs))/2;
      if (interval.instanceId) queues.push({phase,instanceId:interval.instanceId,ms});
    }
    if (pd) {
      const tr=transfers.get(id);
      if (!tr || tr.startUs<tr.prefillCompleteUs || tr.endUs<tr.startUs || tr.endUs>firstUs+1 || tr.aloneUs<0 || tr.aloneUs>tr.endUs-tr.startUs+1) explainable=false;
      else {
        phases.kvSpace=clip(tr.prefillCompleteUs,tr.startUs);
        const actual=clip(tr.startUs,tr.endUs);
        phases.transferBase=Math.min(actual,tr.aloneUs/1000);
        phases.transferContention=actual-phases.transferBase;
        inspectAt.kvSpace=(tr.prefillCompleteUs+tr.startUs)/2;
        inspectAt.transferBase=inspectAt.transferContention=(tr.startUs+tr.endUs)/2;
        queues.push({phase:'kvSpace',instanceId:tr.decodeInstanceId,ms:phases.kvSpace});
      }
    }
    const accounted=Object.values(phases).reduce((a,b)=>a+b,0);
    if (accounted>ttft+0.001) explainable=false;
    phases.firstTokenWork=Math.max(0,ttft-accounted);
    phases.afterFirstToken=response-ttft;
    inspectAt.firstTokenWork=firstUs;
    inspectAt.afterFirstToken=firstUs+(terminal.timeUs-firstUs)/2;
    measured.set(requestKey(arrival),{key:requestKey(arrival),requestId:id,arrival,ttftMs:ttft,responseMs:response,phases:explainable?phases:null,inspectAt,queues});
  }
  // Planned turns remain in the denominator even if a failed session never emits them.
  const total=Math.max(planned,side.metrics.injected_requests,arrivals);
  const failed=Math.min(total-completed,Math.max(failedEvents,side.metrics.failed_requests ?? 0));
  const score: TargetScore={total,completed,measured:measured.size,failed,unfinished:Math.max(0,total-completed-failed),firstTokenWithin,responseWithin,bothWithin,percent:total?bothWithin/total*100:0,meets:total>0 && bothWithin*100>=targets.requiredPercent*total,missingMeasurements:completed-measured.size};
  return {score,measured};
}

export function assessComparison(result: Comparison, targets: LatencyTargets): Assessment | null {
  if (!validTargets(targets)) return null;
  const planned=result.config.workload==='agents'?result.config.sessions*result.config.turns:result.config.requests;
  const basic=analyzeSide(result.basic,targets,planned,result.config.disaggregated);
  const llmd=analyzeSide(result.llmd,targets,planned,result.config.disaggregated);
  const pairs=[...basic.measured].flatMap(([key,a])=>{const b=llmd.measured.get(key);return b?[{a,b}]:[];});
  const explained=pairs.filter(p=>p.a.phases && p.b.phases);
  const phaseKeys=(Object.keys(phaseLabels) as Phase[]).filter(phase=>result.config.disaggregated?phase!=='engineQueue':!['prefillQueue','kvSpace','transferBase','transferContention','decodeQueue'].includes(phase));
  const phases: PhaseComparison[]=phaseKeys.map(phase=>{
    let a=0,b=0;
    let evidence: PhaseComparison['evidence'];
    for (const pair of explained) {
      const av=pair.a.phases![phase], bv=pair.b.phases![phase], delta=bv-av;
      a+=av;b+=bv;
      if (Math.abs(delta)>Math.abs(evidence?.deltaMs ?? 0)) {
        const policy=delta>0?'llmd':'basic';
        const request=policy==='llmd'?pair.b:pair.a;
        evidence={key:request.key,policy,timeUs:request.inspectAt[phase] ?? request.arrival.timeUs,deltaMs:delta};
      }
    }
    const n=explained.length || 1;
    return {phase,label:phaseLabels[phase],basicMs:a/n,llmdMs:b/n,deltaMs:(b-a)/n,evidence};
  });
  const hotspots: QueueHotspot[]=[];
  for (const policy of ['basic','llmd'] as const) {
    const groups=new Map<string,{instanceId:string;phase:Phase;totalMs:number;requests:Set<string>}>();
    for (const pair of explained) {
      const request=policy==='basic'?pair.a:pair.b;
      for (const queue of request.queues) {
        const key=`${queue.phase}/${queue.instanceId}`;
        const group=groups.get(key) ?? {...queue,totalMs:0,requests:new Set<string>()};
        group.totalMs+=queue.ms;group.requests.add(request.key);groups.set(key,group);
      }
    }
    const top=[...groups.values()].filter(g=>g.totalMs>0 && queuePhases.includes(g.phase)).sort((a,b)=>b.totalMs-a.totalMs)[0];
    if (top) hotspots.push({policy,phase:top.phase,instanceId:top.instanceId,requests:top.requests.size,meanMs:top.totalMs/top.requests.size,totalMs:top.totalMs});
  }
  return {version:1,targets:{...targets},basic:basic.score,llmd:llmd.score,
    verdict:basic.score.meets?(llmd.score.meets?'both':'basic-only'):(llmd.score.meets?'llmd-only':'neither'),
    coverageDeltaPoints:llmd.score.percent-basic.score.percent,pairedCompleted:pairs.length,explainedRequests:explained.length,excludedBreakdowns:pairs.length-explained.length,
    meanTTFTDeltaMs:pairs.length?pairs.reduce((sum,p)=>sum+p.b.ttftMs-p.a.ttftMs,0)/pairs.length:null,
    meanResponseDeltaMs:pairs.length?pairs.reduce((sum,p)=>sum+p.b.responseMs-p.a.responseMs,0)/pairs.length:null,
    phases:explained.length?phases:[],hotspots};
}
