import type { Comparison } from './types';
import type { Assessment, LatencyTargets, PhaseComparison, TargetScore } from './analysis';
import { phaseLabels, validTargets } from './analysis';
import { formatMs } from './playback';
import { FieldLabel } from './FieldLabel';
import { inputHelp } from './inputHelp';

const percent = (n: number) => `${n.toFixed(2).replace(/\.?0+$/, '')}%`;
const difference = (n: number) => Math.abs(n)<0.1?'Within 0.1 ms':`${n>0?'+':'−'}${formatMs(Math.abs(n))}`;
const titles = {both:'Both strategies meet your targets.', 'llmd-only':'llm-d meets your targets; basic routing falls short.', 'basic-only':'Basic routing meets your targets; llm-d falls short.', neither:'Neither strategy meets your targets.'};
const suggestions = {
  both:'Both are candidates for a deployment trial at this workload and GPU budget.',
  'llmd-only':'The simulated llm-d policy clears the requirement at the same GPU budget.',
  'basic-only':'This configuration does not show a target-meeting benefit from llm-d.',
  neither:'Use the timing breakdown to choose what to change, then compare again.',
};

export function ResultsSummary({result,targets,assessment,onTargets,onInspect}: {result?:Comparison;targets:LatencyTargets;assessment:Assessment|null;onTargets:(targets:LatencyTargets)=>void;onInspect:(evidence:NonNullable<PhaseComparison['evidence']>)=>void}) {
  const valid=validTargets(targets);
  const drivers=assessment?.phases.filter(p=>Math.abs(p.deltaMs)>=0.1).sort((a,b)=>Math.abs(b.deltaMs)-Math.abs(a.deltaMs)).slice(0,2) ?? [];
  return <div className="results-summary">
    <div className="target-heading"><h3>Latency targets</h3><span>Reassess instantly · no simulation rerun</span></div>
    <div className="latency-targets">
      <div className="field"><FieldLabel htmlFor="target-first-token" label="First token within (ms)" help={inputHelp.firstToken} /><input id="target-first-token" type="number" min="1" max="3600000" step="any" required value={targets.ttftMs || ''} onChange={e=>onTargets({...targets,ttftMs:e.target.valueAsNumber})} aria-invalid={!Number.isFinite(targets.ttftMs)||targets.ttftMs<1||targets.ttftMs>3600000}/></div>
      <div className="field"><FieldLabel htmlFor="target-full-response" label="Full response within (ms)" help={inputHelp.fullResponse} /><input id="target-full-response" type="number" min="1" max="3600000" step="any" required value={targets.responseMs || ''} onChange={e=>onTargets({...targets,responseMs:e.target.valueAsNumber})} aria-invalid={!Number.isFinite(targets.responseMs)||targets.responseMs<1||targets.responseMs>3600000}/></div>
      <div className="field"><FieldLabel htmlFor="target-share" label="Requests meeting both (%)" help={inputHelp.targetShare} /><input id="target-share" type="number" min="1" max="100" step="any" required value={targets.requiredPercent || ''} onChange={e=>onTargets({...targets,requiredPercent:e.target.valueAsNumber})} aria-invalid={!Number.isFinite(targets.requiredPercent)||targets.requiredPercent<1||targets.requiredPercent>100}/></div>
    </div>
    <p className="target-help">Example targets; edit them to match your needs. {result?.config.workload==='agents'?'Applies to each model call, not the entire agent session. ':''}Both time limits must be met by the same request. Failed, unfinished, and unmeasured requests count as misses.</p>
    {!valid && <p className="target-error" role="alert">Enter time limits from 1 to 3,600,000 ms and a percentage from 1 to 100.</p>}
    {!result && valid && <p className="summary-empty">Run a comparison to assess workload fit and see where requests spend their time.</p>}
    {assessment && <>
      <div className={`fit-verdict ${assessment.verdict}`} role="status"><strong>{titles[assessment.verdict]}</strong><p>{suggestions[assessment.verdict]} {Math.abs(assessment.coverageDeltaPoints)<0.005?'Both meet the limits for the same share of requests.':`llm-d changes the share meeting both limits by ${assessment.coverageDeltaPoints>0?'+':'−'}${Math.abs(assessment.coverageDeltaPoints).toFixed(2)} percentage points.`}</p></div>
      <div className="fit-cards"><FitCard title="Basic routing" variant="basic" score={assessment.basic} targets={targets}/><FitCard title="llm-d routing" variant="llmd" score={assessment.llmd} targets={targets}/></div>
      <p className="assessment-scope">Full-run simulated outcomes · {result?.config.workload==='agents'?'all planned turns, including any not emitted':'all offered requests'}. {Math.min(assessment.basic.total,assessment.llmd.total)<100?'Small sample: each request can materially change the percentage. ':''}These results describe this workload and configuration.</p>
      <div className="latency-explanation">
        <h3>What differs in this run</h3>
        {assessment.pairedCompleted>0 ? <p>On {assessment.pairedCompleted} matched completed requests, llm-d changes mean first-token time by <b>{difference(assessment.meanTTFTDeltaMs!)}</b> and mean response time by <b>{difference(assessment.meanResponseDeltaMs!)}</b>.</p> : <p>No requests have valid completed latency records on both sides, so a matched timing explanation is unavailable.</p>}
        {!!drivers.length && <div className="latency-drivers">{drivers.map(p=><div key={p.phase}><div><span>{p.label}</span><strong>{difference(p.deltaMs)} <small>per request with llm-d</small></strong></div>{p.evidence && <button onClick={()=>onInspect(p.evidence!)}>Inspect largest request gap ↗</button>}</div>)}</div>}
        {drivers.some(p=>p.phase==='preparation') && <p>Input preparation includes render/tokenize work and waiting for endpoint admission, recorded together before the engine queue.</p>}
        {assessment.phases.length>0 && !drivers.length && <p>The recorded mean phase times differ by less than 0.1 ms each.</p>}
        {assessment.hotspots.map(h=><p className="queue-finding" key={h.policy}><b>{h.policy==='basic'?'Basic':'llm-d'} queue concentration:</b> {phaseLabels[h.phase]} on Instance {Number(h.instanceId.match(/\d+$/)?.[0] ?? 0)+1} has the most accumulated wait before first token: {formatMs(h.totalMs)} across {h.requests} requests ({formatMs(h.meanMs)} on average).</p>)}
        <details className="phase-breakdown"><summary>Timing breakdown{assessment.explainedRequests>0?` · ${assessment.explainedRequests} matched completed requests`:''}</summary>
          {assessment.phases.length>0 ? <>
            <p>Mean time per request, using the same completed pairs on both sides. Queue and transfer rows cover the path to the first token. The final row covers the rest of the response, including later queueing and output overhead. These means add up; percentile values do not.</p>
            <div className="metrics-table"><table><thead><tr><th>Recorded phase</th><th>Basic</th><th>llm-d</th><th>llm-d − Basic</th></tr></thead><tbody>{assessment.phases.map(p=><tr key={p.phase}><th>{p.label}</th><td>{formatMs(p.basicMs)}</td><td>{formatMs(p.llmdMs)}</td><td>{difference(p.deltaMs)}</td></tr>)}</tbody></table></div>
            <p>KV contention is the recorded transfer duration minus its standalone cost. Prompt processing + first-token overhead is the remaining BLIS first-token time after recorded preparation, queues, and transfers. Differences are observed contributions, not predictions about an unchosen route.</p>
          </> : <p>There are no complete paired timelines available for a reliable phase breakdown.</p>}
          {assessment.excludedBreakdowns>0 && <p>{assessment.excludedBreakdowns} matched requests lack a complete, consistent phase timeline and are excluded from this breakdown. Their measured latencies still count toward targets.</p>}
        </details>
      </div>
    </>}
  </div>;
}

function FitCard({title,variant,score,targets}: {title:string;variant:string;score:TargetScore;targets:LatencyTargets}) {
  return <div className={`fit-card ${variant}`}>
    <div className="fit-card-heading"><h3>{title}</h3><span className={`fit-badge ${score.meets?'met':'missed'}`}>{score.meets?'Meets targets':'Below target'}</span></div>
    <div className="fit-number"><strong>{percent(score.percent)}</strong><span>{score.bothWithin} / {score.total} requests meet both</span></div>
    <div className="fit-meter" role="img" aria-label={`${percent(score.percent)} meet both limits; ${percent(targets.requiredPercent)} required`}><span style={{width:`${score.percent}%`}}/><i style={{left:`${targets.requiredPercent}%`}}/></div>
    <p className="fit-required">Required: {percent(targets.requiredPercent)} · {Math.ceil(score.total*targets.requiredPercent/100)} requests</p>
    <dl><div><dt>First token ≤ {formatMs(targets.ttftMs)}</dt><dd>{score.firstTokenWithin} / {score.total}</dd></div><div><dt>Full response ≤ {formatMs(targets.responseMs)}</dt><dd>{score.responseWithin} / {score.total}</dd></div></dl>
    <p className="fit-outcomes">{score.completed} completed · {score.failed} failed · {score.unfinished} unfinished{score.missingMeasurements>0?` · ${score.missingMeasurements} completed without valid latency`:''}</p>
  </div>;
}
