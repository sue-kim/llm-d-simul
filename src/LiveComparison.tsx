import type { Comparison } from './types';
import { comparisonAt, comparisonStages } from './comparisonPlayback';
import type { PlaybackComparison } from './comparisonPlayback';

const labels = { waiting: 'Waiting', running: 'Running', transferring: 'KV in transit', finished: 'Finished' };

export function LiveComparison({ result, model, time, onJump }: {
  result: Comparison; model: PlaybackComparison; time: number; onJump: (timeUs: number) => void;
}) {
  const current = comparisonAt(model, time);
  const stages = comparisonStages.filter(stage => stage !== 'transferring' || result.config.disaggregated);
  const same = stages.every(stage => current.basic[stage] === current.llmd[stage]);
  const ended = time >= result.endTimeUs;
  return <section className="live-comparison" aria-label="Live request comparison">
    <div className="live-comparison-heading">
      <h3>At this moment <span>{(time / 1e6).toFixed(2)} s</span></h3>
      {model.largestGap && <button type="button" onClick={() => onJump(model.largestGap!.timeUs)} title={`Pause at the largest request-count gap: ${model.largestGap.count} ${labels[model.largestGap.stage].toLowerCase()} requests`}>
        Show largest count gap <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>
      </button>}
    </div>
    <table className="live-counts">
      <thead><tr><th scope="col">Requests</th><th scope="col">Basic</th><th scope="col">llm-d</th><th scope="col">llm-d vs Basic</th></tr></thead>
      <tbody>{stages.map(stage => {
        const delta = current.llmd[stage] - current.basic[stage];
        return <tr key={stage}>
          <th scope="row">{labels[stage]}</th>
          {(['basic', 'llmd'] as const).map(policy => <td key={policy} className={policy}>
            <div className="count-bar-cell"><span className="count-track" aria-hidden="true"><i style={{ width: `${current[policy][stage] / Math.max(1, model.scale[stage]) * 100}%` }} /></span><span>{current[policy][stage]}</span></div>
          </td>)}
          <td className={delta === 0 ? 'count-same' : 'count-difference'}>{delta === 0 ? 'Same' : `${Math.abs(delta)} ${delta > 0 ? 'more' : 'fewer'}`}</td>
        </tr>;
      })}</tbody>
    </table>
    <p className="live-comparison-note">{ended ? 'Playback finished.' : same ? 'Counts match now; instance placement can still differ.' : 'Counts at the same simulated time.'} {ended && model.largestGap ? 'Use the gap shortcut to replay the difference.' : !model.largestGap ? 'Stage counts match throughout this run.' : ''}</p>
    <details className="live-comparison-help"><summary>How to read this</summary><p>Each row uses one fixed scale for both sides across the run. Waiting includes input preparation, engine queues, and waiting for KV space. Running counts active requests, not GPU utilization. More running requests can mean more work in progress, not faster processing. The shortcut pauses at the largest absolute count gap in these rows.{result.config.workload === 'agents' ? ' Agent turns can arrive at different times because each session waits for its previous response.' : ''}</p></details>
    {(current.basic.failed > 0 || current.llmd.failed > 0) && <p className="live-comparison-failures">Failed requests: Basic {current.basic.failed} · llm-d {current.llmd.failed}. Failed requests are excluded from the rows above.</p>}
  </section>;
}
