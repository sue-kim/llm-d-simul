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
    <div className="target-heading"><h3>Latency targets</h3><span>Updates without rerunning</span></div>
    <div className="latency-targets">
      <div className="field"><FieldLabel htmlFor="target-first-token" label="First token within (ms)" help={inputHelp.firstToken} /><input id="target-first-token" type="number" min="1" max="3600000" step="any" required value={targets.ttftMs || ''} onChange={e=>onTargets({...targets,ttftMs:e.target.valueAsNumber})} aria-invalid={!Number.isFinite(targets.ttftMs)||targets.ttftMs<1||targets.ttftMs>3600000}/></div>
      <div className="field"><FieldLabel htmlFor="target-full-response" label="Full response within (ms)" help={inputHelp.fullResponse} /><input id="target-full-response" type="number" min="1" max="3600000" step="any" required value={targets.responseMs || ''} onChange={e=>onTargets({...targets,responseMs:e.target.valueAsNumber})} aria-invalid={!Number.isFinite(targets.responseMs)||targets.responseMs<1||targets.responseMs>3600000}/></div>
      <div className="field"><FieldLabel htmlFor="target-share" label="Requests meeting both (%)" help={inputHelp.targetShare} /><input id="target-share" type="number" min="1" max="100" step="any" required value={targets.requiredPercent || ''} onChange={e=>onTargets({...targets,requiredPercent:e.target.valueAsNumber})} aria-invalid={!Number.isFinite(targets.requiredPercent)||targets.requiredPercent<1||targets.requiredPercent>100}/></div>
    </div>
    <p className="target-help">Each request must meet both limits.{result?.config.workload==='agents'?' Assessed per model call, not per session.':''}</p>
    {!valid && <p className="target-error" role="alert">Enter time limits from 1 to 3,600,000 ms and a percentage from 1 to 100.</p>}
    {!result && valid && <p className="summary-empty">Run a comparison to assess workload fit and see where requests spend their time.</p>}
    {assessment && <>
      <div className="fit-verdict" role="status"><strong>{titles[assessment.verdict]}</strong>{Math.abs(assessment.coverageDeltaPoints)>=0.005 && <span>llm-d: {assessment.coverageDeltaPoints>0?'+':'−'}{Math.abs(assessment.coverageDeltaPoints).toFixed(2)} percentage points meeting both.</span>}</div>
      <div className="fit-summary" aria-label="Requests meeting both targets">
        <div className="fit-summary-heading"><span>Meeting both targets</span><span>{percent(targets.requiredPercent)} required</span></div>
        <FitRow title="Basic routing" variant="basic" score={assessment.basic}/>
        <FitRow title="llm-d routing" variant="llmd" score={assessment.llmd}/>
      </div>
      <details className="target-details"><summary>Target details</summary>
        <div className="metrics-table"><table><thead><tr><th scope="col">Requests</th><th scope="col">Basic</th><th scope="col">llm-d</th></tr></thead><tbody>
          <tr><th scope="row">First token ≤ {formatMs(targets.ttftMs)}</th><td>{assessment.basic.firstTokenWithin} / {assessment.basic.total}</td><td>{assessment.llmd.firstTokenWithin} / {assessment.llmd.total}</td></tr>
          <tr><th scope="row">Full response ≤ {formatMs(targets.responseMs)}</th><td>{assessment.basic.responseWithin} / {assessment.basic.total}</td><td>{assessment.llmd.responseWithin} / {assessment.llmd.total}</td></tr>
          <tr><th scope="row">Required to meet both</th><td>{Math.ceil(assessment.basic.total*targets.requiredPercent/100)}</td><td>{Math.ceil(assessment.llmd.total*targets.requiredPercent/100)}</td></tr>
          <tr><th scope="row">Completed</th><td>{assessment.basic.completed}</td><td>{assessment.llmd.completed}</td></tr>
          <tr><th scope="row">Failed / unfinished</th><td>{assessment.basic.failed} / {assessment.basic.unfinished}</td><td>{assessment.llmd.failed} / {assessment.llmd.unfinished}</td></tr>
          {(assessment.basic.missingMeasurements>0 || assessment.llmd.missingMeasurements>0) && <tr><th scope="row">Completed without valid latency</th><td>{assessment.basic.missingMeasurements}</td><td>{assessment.llmd.missingMeasurements}</td></tr>}
        </tbody></table></div>
        <p>Failed, unfinished, and unmeasured requests count as misses. {suggestions[assessment.verdict]}</p>
      </details>
      <p className="assessment-scope">Simulated · {result?.config.workload==='agents'?'all planned model calls, including un-emitted turns':'all offered requests'}.{Math.min(assessment.basic.total,assessment.llmd.total)<100?' Small sample; percentages may vary substantially.':''}</p>
      <details className="latency-explanation">
        <summary>Why results differ{assessment.pairedCompleted>0 && <span>Mean first token {difference(assessment.meanTTFTDeltaMs!)} · response {difference(assessment.meanResponseDeltaMs!)}</span>}</summary>
        <div className="latency-explanation-content">
        {assessment.pairedCompleted>0 ? <p>On {assessment.pairedCompleted} matched completed requests, llm-d changes mean first-token time by <b>{difference(assessment.meanTTFTDeltaMs!)}</b> and mean response time by <b>{difference(assessment.meanResponseDeltaMs!)}</b>.</p> : <p>No requests have valid completed latency records on both sides, so a matched timing explanation is unavailable.</p>}
        {!!drivers.length && <div className="latency-drivers">{drivers.map(p=><div key={p.phase}><span>{p.label}</span><strong>{difference(p.deltaMs)}</strong>{p.evidence && <button type="button" aria-label={`Inspect largest request gap: ${p.label}`} onClick={()=>onInspect(p.evidence!)}>Inspect request ↗</button>}</div>)}</div>}
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
      </details>
    </>}
  </div>;
}

function FitRow({title,variant,score}: {title:string;variant:string;score:TargetScore}) {
  const exceptions = [score.failed>0?`${score.failed} failed`:'',score.unfinished>0?`${score.unfinished} unfinished`:'',score.missingMeasurements>0?`${score.missingMeasurements} unmeasured`:''].filter(Boolean);
  return <div className={`fit-row ${variant}`}>
    <h3>{title}</h3><strong className="fit-percent">{percent(score.percent)}</strong>
    <span className="fit-count">{score.bothWithin} / {score.total} requests</span>
    <span className={`fit-status ${score.meets?'met':'missed'}`}>{score.meets?'Meets targets':'Below target'}</span>
    {!!exceptions.length && <p className="fit-exceptions">{exceptions.join(' · ')}</p>}
  </div>;
}
