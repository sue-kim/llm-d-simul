import { useEffect, useMemo, useRef, useState } from 'react';
import type { Comparison, Config, DeploymentOptions, Event, Side, Stage } from './types';
import { formatMs, formatNumber, requestStates, snapshotAt } from './playback';

const defaults: Config = { workload: 'chat', model: 'llama-3.1-8b-instruct', hardware: 'h100', instances: 4, requests: 256, rate: 40, inputTokens: 256, outputTokens: 256, prefixTokens: 512, seed: 42 };
const stageLabel: Record<Stage, string> = { arrived: 'Arrived', routed: 'Preparing input', queued: 'Queued', processing: 'Processing', streaming: 'Streaming', completed: 'Finished', preempted: 'Queued again', timed_out: 'Timed out' };
const active = (e: Event) => e.kind === 'processing' || e.kind === 'streaming';
const waiting = (e: Event) => e.kind === 'queued' || e.kind === 'preempted';

function Icon({ name, size = 18 }: { name: 'play' | 'pause' | 'reset' | 'step' | 'arrow' | 'download' | 'chip' | 'route'; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'play' && <path d="m8 5 11 7-11 7Z" />}
    {name === 'pause' && <><path d="M8 5v14M16 5v14" /></>}
    {name === 'reset' && <><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" /></>}
    {name === 'step' && <><path d="m5 5 10 7-10 7ZM19 5v14" /></>}
    {name === 'arrow' && <path d="M5 12h14m-5-5 5 5-5 5" />}
    {name === 'download' && <><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" /></>}
    {name === 'chip' && <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4" /><rect x="9" y="9" width="6" height="6" /></>}
    {name === 'route' && <><path d="M4 12h7m0 0V5h5m-5 7v7h5" /><circle cx="19" cy="5" r="2" /><circle cx="19" cy="19" r="2" /></>}
  </svg>;
}

export function App() {
  const [config, setConfig] = useState<Config>(defaults);
  const [result, setResult] = useState<Comparison>();
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [deployments, setDeployments] = useState<DeploymentOptions>();
  const [error, setError] = useState('');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const requestController = useRef<AbortController | null>(null);
  const end = result?.endTimeUs ?? 1;
  const changed = !!result && JSON.stringify(config) !== JSON.stringify(result.config);
  const selectedModel = deployments?.models.find(model => model.id === config.model);
  const selectedHardware = deployments?.hardware.find(hardware => hardware.id === config.hardware);
  const resultHardware = result ? result.deployment?.hardware.shortLabel ?? result.config.hardware : selectedHardware?.shortLabel ?? 'GPU';

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/health', { signal: ctrl.signal }).then(r => r.json()).then(data => {
      setDeployments(data.deployments);
      setReady(data.ready && !!data.deployments);
      if (!data.ready) setError('BLIS is not installed yet. Run npm run setup in the repository, then reload.');
      else if (!data.deployments) setError('Restart the simulation API to load the model and GPU options.');
    }).catch(e => { if (e.name !== 'AbortError') setError('The simulation API is unavailable. Start it with npm run dev.'); });
    return () => { ctrl.abort(); requestController.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!playing || !result) return;
    let last = performance.now(), frame = 0;
    function tick(now: number) {
      const elapsed = Math.min(now - last, 250) * 1000 * speed;
      last = now;
      setTime(t => Math.min(t + elapsed, end));
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, result, end]);
  useEffect(() => { if (time >= end) setPlaying(false); }, [time, end]);

  async function run() {
    setBusy(true); setError(''); setPlaying(false);
    const ctrl = new AbortController(); requestController.current = ctrl;
    try {
      const response = await fetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config), signal: ctrl.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Simulation failed. Try a smaller workload.');
      setResult(data); setTime(0); setPlaying(!window.matchMedia('(prefers-reduced-motion: reduce)').matches); setSelected(data.basic.playback.events.find((e: Event) => e.kind === 'arrived')?.requestId ?? '');
    } catch (e) { if (e instanceof Error && e.name !== 'AbortError') setError(e.message); }
    finally { setBusy(false); }
  }
  function update<K extends keyof Config>(key: K, value: Config[K]) { setConfig(c => ({ ...c, [key]: value })); }
  function selectModel(modelId: string) {
    const model = deployments?.models.find(option => option.id === modelId);
    if (!model) return;
    setConfig(c => ({ ...c, model: modelId, hardware: model.hardwareIds.includes(c.hardware) ? c.hardware : model.hardwareIds[0] }));
  }
  function preset(workload: Config['workload']) { setConfig(c => ({ ...c, workload, inputTokens: workload === 'chat' ? 256 : 4096, outputTokens: workload === 'chat' ? 256 : 512, prefixTokens: workload === 'chat' ? 512 : 0 })); }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `llmd-comparison-${result.id}.json`; link.click(); URL.revokeObjectURL(url);
  }
  const allRequests = useMemo(() => result?.basic.playback.events.filter(e => e.kind === 'arrived') ?? [], [result]);
  const filtered = allRequests.filter(e => e.requestId.toLowerCase().includes(search.toLowerCase()));
  const states = useMemo(() => ({ basic: requestStates(result?.basic.playback.events ?? [], time), llmd: requestStates(result?.llmd.playback.events ?? [], time) }), [result, time]);
  const visibleRequests = filtered.slice(0, 24);
  const selectedEvent = allRequests.find(e => e.requestId === selected);

  return <div className="app">
    <header className="topbar">
      <a className="brand" href="/" aria-label="llm-d simulator home"><Icon name="route" size={25} /><strong>llm-d</strong><span>/ simulator</span></a>
      <div className="topbar-meta"><span className={`connection ${ready ? 'connected' : ''}`}>{ready ? 'BLIS connected' : 'Connecting to BLIS'}</span><a href="https://github.com/sue-kim/llm-d-simul" target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a></div>
    </header>
    <div className="workspace">
      <aside className="settings">
        <form onSubmit={e => { e.preventDefault(); void run(); }}>
          <fieldset disabled={busy || !ready}>
            <h2>Workload</h2><p className="section-help">Start with an example. Make it yours.</p>
            <div className="preset-options" aria-label="Workload examples">
              <button type="button" aria-pressed={config.workload === 'chat'} onClick={() => preset('chat')}><strong>Chat</strong><span>Short prompts, streaming replies</span></button>
              <button type="button" aria-pressed={config.workload === 'summarization'} onClick={() => preset('summarization')}><strong>Summarization</strong><span>Long documents, shorter answers</span></button>
            </div>
            <div className="paired-fields"><NumberField label="Input tokens" value={config.inputTokens} min={16} max={8192} onChange={v => update('inputTokens', v)} /><NumberField label="Output tokens" value={config.outputTokens} min={16} max={2048} onChange={v => update('outputTokens', v)} /></div>
            <NumberField label="Shared prefix tokens" value={config.prefixTokens} min={0} max={4096} onChange={v => update('prefixTokens', v)} />
            <p className="field-help">Added to each input. Models a shared system prompt or document context.</p>
            <label className="range-label" htmlFor="traffic">Traffic <strong>{config.rate} <span>req/s</span></strong></label>
            <input id="traffic" type="range" min="1" max="300" value={config.rate} onChange={e => update('rate', +e.target.value)} />
            <div className="range-ends"><span>1 req/s</span><span>300 req/s</span></div>
            <div className="paired-fields"><NumberField label="Requests" value={config.requests} min={16} max={1024} onChange={v => update('requests', v)} /><NumberField label="Seed" value={config.seed} min={0} max={1000000} onChange={v => update('seed', v)} /></div>
            <div className="settings-divider" />
            <h2>Infrastructure</h2><p className="section-help">Your selection applies to both sides.</p>
            <div className="model-setting">
              <label className="field">Model<select value={config.model} onChange={e => selectModel(e.target.value)}>{deployments ? deployments.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>) : <option value={config.model}>Loading models…</option>}</select></label>
              <small>{deployments ? `${deployments.precision} · ${deployments.contextLimit.toLocaleString()} token simulation context` : 'Loading model settings…'}</small>
            </div>
            <div className="gpu-setting">
              <label className="field">GPU<select value={config.hardware} onChange={e => update('hardware', e.target.value)}>{deployments ? deployments.hardware.map(hardware => <option key={hardware.id} value={hardware.id} disabled={!selectedModel?.hardwareIds.includes(hardware.id)}>{hardware.label}</option>) : <option value={config.hardware}>Loading GPUs…</option>}</select></label>
              <p className="field-help">{selectedHardware ? `${selectedHardware.memoryGiB.toFixed(2)} GiB modeled memory · one GPU per instance` : 'Loading GPU settings…'}</p>
            </div>
            <label className="field">Instances<select value={config.instances} onChange={e => update('instances', +e.target.value)}>{[2,3,4,5,6,7,8].map(n => <option key={n} value={n}>{n} instances · {n} GPUs</option>)}</select></label>
            <p className="field-help">{config.instances} × {selectedHardware?.shortLabel ?? 'GPU'} per side. Same model, precision, and GPU count.</p>
            <button className="run-button" type="submit" disabled={!ready || busy}>{busy ? <span className="spinner" /> : <Icon name="play" />} {busy ? 'Running BLIS…' : 'Run comparison'}</button>
            <p className="run-note">Runs locally on your CPU. No GPUs required.</p>
          </fieldset>
        </form>
      </aside>

      <main>
        <div className="page-heading"><div><h1>Compare inference routing</h1><p>One workload. Two routing strategies. Follow every request.</p></div><button className="text-button export" disabled={!result || busy} onClick={download}><Icon name="download" />Export run</button></div>
        {error && <div className="error" role="alert"><strong>Couldn’t complete the comparison</strong><p>{error}</p></div>}
        <div className="comparison-context"><span className="verified-dot" /><span>{result ? `${result.config.requests} identical requests · ${result.deployment?.model.label ?? result.config.model} · ${result.config.instances} ${resultHardware} GPUs per side` : 'Matched requests, model, hardware, and engine settings'}</span><span className="synthetic-label">Synthetic workload</span></div>
        {changed && <p className="changed-note" role="status">Settings changed. Run again to update the comparison below.</p>}
        {busy && <div className="busy-note" role="status"><span className="spinner" /><span>Computing both BLIS runs. Playback will be ready when they finish.</span></div>}
        <section className="comparison" aria-label="Side-by-side simulation">
          <Cluster title="Basic load balancing" description="Random endpoint selection" variant="basic" side={result?.basic} instances={result?.config.instances ?? config.instances} hardware={resultHardware} states={states.basic} time={time} selected={selected} onSelect={setSelected} />
          <Cluster title="llm-d routing" description="In-flight load, queue, and cache scoring" variant="llmd" side={result?.llmd} instances={result?.config.instances ?? config.instances} hardware={resultHardware} states={states.llmd} time={time} selected={selected} onSelect={setSelected} />
        </section>
        <div className="playback-controls" aria-label="Simulation playback">
          <button className="play-button" aria-label={playing ? 'Pause playback' : 'Play playback'} disabled={!result || busy} onClick={() => { if (time >= end) setTime(0); setPlaying(!playing); }}><Icon name={playing ? 'pause' : 'play'} /></button>
          <button className="icon-button" aria-label="Restart playback" disabled={!result || busy} onClick={() => {setTime(0); setPlaying(false);}}><Icon name="reset" /></button>
          <button className="icon-button" aria-label="Step forward 100 milliseconds" disabled={!result || busy} onClick={() => {setPlaying(false); setTime(t => Math.min(t + 100000, end));}}><Icon name="step" /></button>
          <span className="clock">{(time / 1e6).toFixed(2)} <small>/ {result ? (end / 1e6).toFixed(2) : '0.00'} s</small></span>
          <input type="range" aria-label="Simulation time" min="0" max={end} step="1000" value={time} disabled={!result || busy} onChange={e => {setPlaying(false); setTime(+e.target.value);}} />
          <select aria-label="Playback speed" value={speed} onChange={e => setSpeed(+e.target.value)}>{[0.25,0.5,1,2,4].map(s => <option value={s} key={s}>{s}×</option>)}</select>
          <span className="playback-caption">Simulated time</span>
        </div>

        <section className="results-section" aria-labelledby="results-title"><div className="section-heading"><h2 id="results-title">Full run results</h2><span>{result ? 'Completed-request latency · common throughput window' : 'Run a comparison to see measured simulation outputs'}</span></div>
          <Results result={result} />
        </section>

        <section className="inspection-section" aria-labelledby="inspector-title">
          <div className="section-heading"><h2 id="inspector-title">Inspect a request</h2><span>Select a request on either side to follow its path.</span></div>
          <div className="inspection-grid">
            <div className="request-list"><label className="search-label">Find request<input type="search" placeholder="Search request ID" value={search} onChange={e => setSearch(e.target.value)} disabled={!result} /></label>
              <div className="request-table-head"><span>Request</span><span>Basic</span><span>llm-d</span></div>
              <div className="request-rows">{visibleRequests.map(e => <button key={e.requestId} aria-pressed={selected === e.requestId} onClick={() => setSelected(e.requestId)}><span className="request-id">{e.requestId}</span><StageTag event={states.basic.get(e.requestId)} /><StageTag event={states.llmd.get(e.requestId)} /></button>)}{!visibleRequests.length && <p className="empty-copy">{result ? 'No requests match this ID.' : 'Requests appear here after your first run.'}</p>}</div>
              {!!allRequests.length && <p className="table-foot">Showing {visibleRequests.length} of {filtered.length} requests. Search to inspect any ID.</p>}
            </div>
            <div className="request-detail">{result && selectedEvent ? <>
              <div className="detail-title"><strong>{selected}</strong><span>{selectedEvent.inputTokens.toLocaleString()} input · {selectedEvent.outputTokens.toLocaleString()} output tokens</span></div>
              <div className="detail-sides"><RequestDetail side={result.basic} requestId={selected} current={states.basic.get(selected)} time={time} /><RequestDetail side={result.llmd} requestId={selected} current={states.llmd.get(selected)} time={time} /></div>
            </> : <div className="inspector-empty"><Icon name="route" size={30} /><h3>See what a request waited for.</h3><p>Inspect its recorded queue time, assigned instance, and routing decision in both runs.</p></div>}</div>
          </div>
        </section>
        <details className="methodology"><summary>How this comparison works <span>BLIS v0.12.0</span></summary><div>
          <p>Basic routing uses random selection; llm-d uses the upstream in-flight load configuration. Both execute inside BLIS’s embedded llm-d router, with the same engine settings and cold caches. These are simulated policy results, with zero router decision time.</p>
          <p>Input and output lengths use bounded synthetic distributions with 25% standard deviation. Shared context is added to each input. Chat and summarization are editable examples inspired by the BLIS catalog, rather than production traces.</p>
          <p>Model and GPU options come from the pinned BLIS catalog and have been exercised in this simulator. All use BF16 weights and KV cache, one GPU per instance, and a 32,768-token engine limit. GPU memory values follow the catalog’s modeled capacity in GiB. These checks establish compatibility; accuracy depends on BLIS’s coefficient coverage for the selected deployment.</p>
          <p>Request transitions are recorded from the engine. Gauges use snapshots approximately every 50 ms. “Processing” includes prompt processing; “streaming” begins at the recorded first token. Full run metrics remain fixed while you replay.</p>
          {result && <><p>Run <code>{result.id}</code> · Seed {result.config.seed} · Identical arrivals and token demands verified.</p><dl className="pins">{Object.entries(result.provenance.repositories).map(([name,pin]) => <div key={name}><dt>{name}</dt><dd><a target="_blank" rel="noreferrer" href={`https://github.com/inference-sim/${name}/commit/${pin.commit}`}>{pin.tag} · {pin.commit.slice(0,12)}</a></dd></div>)}</dl><p>Kernel inputs include measured, vendor-specified, and assumed coefficients. Full provenance and raw decisions are included in the exported run.</p></>}
          <a href="https://github.com/inference-sim/inference-sim/blob/v0.12.0/docs/guide/routing.md" target="_blank" rel="noreferrer">Read the BLIS routing methodology ↗</a>
        </div></details>
        <footer>Built to explore tradeoffs. Validate promising configurations against your deployment.</footer>
      </main>
    </div>
  </div>;
}

function NumberField({ label, value, min, max, onChange }: {label: string; value: number; min: number; max: number; onChange: (n: number) => void}) {
  return <label className="field">{label}<input type="number" required value={value} min={min} max={max} step="1" onChange={e => onChange(e.target.value === '' ? 0 : +e.target.value)} /></label>;
}
function StageTag({event}: {event?: Event}) { return <span className={`stage ${event?.kind ?? 'pending'}`}>{event ? stageLabel[event.kind] : 'Not arrived'}</span>; }

function Cluster({title,description,variant,side,instances,hardware,states,time,selected,onSelect}: {title:string;description:string;variant:string;side?:Side;instances:number;hardware:string;states:Map<string,Event>;time:number;selected:string;onSelect:(id:string)=>void}) {
  const snap = snapshotAt(side,time);
  const current = [...states.values()];
  const finished = current.filter(e => e.kind === 'completed').length;
  const queued = current.filter(waiting).length;
  const running = current.filter(active).length;
  const ids = side?.playback.snapshots.at(-1)?.InstanceSnapshots.map(s=>s.ID) ?? Array.from({length:instances},(_,i)=>`instance_${i}`);
  return <article className={`cluster ${variant}`}>
    <div className="cluster-title"><span className="policy-indicator" /><div><h2>{title}</h2><p>{description}</p></div><span className="gpu-count">{instances} × {hardware}</span></div>
    <div className="cluster-summary"><span><strong>{queued}</strong> queued</span><span><strong>{running}</strong> processing</span><span><strong>{finished}</strong> finished</span></div>
    <div className="router"><Icon name="route" /><span>{variant === 'basic' ? 'Random picker' : 'llm-d endpoint picker'}</span><small>{states.size} received</small></div>
    <div className="routing-lines" aria-hidden="true"><span /><span /></div>
    <div className={`instances ${instances > 4 ? 'many' : ''}`}>{ids.map((id,index)=>{
      const events=current.filter(e=>e.instanceId===id);
      const q=events.filter(waiting), inFlight=events.filter(active);
      const s=snap?.InstanceSnapshots.find(s=>s.ID===id);
      const tokens=[...q,...inFlight];
      return <div className={`instance ${tokens.some(e=>e.requestId===selected) ? 'has-selection' : ''}`} key={id}>
        <div className="instance-heading"><Icon name="chip" size={17}/><strong>Instance {index+1}</strong><span className={inFlight.length ? 'instance-active' : ''}>{inFlight.length ? 'Active' : 'Idle'}</span></div>
        <div className="instance-counts"><span><b>{q.length}</b> queued</span><span><b>{inFlight.length}</b> running</span></div>
        <div className="request-dots" aria-label={`Requests on instance ${index+1}`}>{tokens.slice(0,30).map(e=><button key={e.requestId} className={`${waiting(e)?'dot-queued':'dot-active'} ${e.requestId===selected?'dot-selected':''}`} aria-label={`${e.requestId}, ${stageLabel[e.kind]}`} title={`${e.requestId} · ${stageLabel[e.kind]}`} onClick={()=>onSelect(e.requestId)}/>)}{tokens.length>30&&<span className="more-dots">+{tokens.length-30}</span>}{!tokens.length&&<span className="no-requests">{side ? 'No active requests' : 'Ready for requests'}</span>}</div>
        <div className="cache-label"><span>KV cache</span><span>{((s?.KVUtilization??0)*100).toFixed(1)}%</span></div><div className="cache-meter"><span style={{width:`${Math.min(100,(s?.KVUtilization??0)*100)}%`}} /></div>
      </div>;
    })}</div>
    <div className="cluster-legend"><span><i className="dot-queued" />Queued</span><span><i className="dot-active" />Processing / streaming</span><small>One square = one request</small></div>
  </article>;
}

function Results({result}: {result?:Comparison}) {
  const basic=result?.basic.metrics,llmd=result?.llmd.metrics;
  const seconds=(result?.endTimeUs??1)/1e6;
  const rows: {label:string; a?:number; b?:number; format:(v?:number)=>string; lower?:boolean}[] = [
    {label:'Time to first token · median',a:basic?.ttft_p50_ms,b:llmd?.ttft_p50_ms,format:formatMs,lower:true},
    {label:'Time to first token · p95',a:basic?.ttft_p95_ms,b:llmd?.ttft_p95_ms,format:formatMs,lower:true},
    {label:'Response time · p95',a:basic?.e2e_p95_ms,b:llmd?.e2e_p95_ms,format:formatMs,lower:true},
    {label:'Output throughput',a:basic?basic.total_output_tokens/seconds:undefined,b:llmd?llmd.total_output_tokens/seconds:undefined,format:n=>n==null?'—':`${formatNumber(n)} tok/s`},
    {label:'Prefix cache hit rate',a:basic?.cache_hit_rate,b:llmd?.cache_hit_rate,format:n=>n==null?'—':`${(n*100).toFixed(1)}%`},
  ];
  return <div className="metrics-table"><table><thead><tr><th>Metric</th><th>Basic</th><th>llm-d</th><th>Difference</th></tr></thead><tbody>{rows.map(r=>{
    const delta=r.a!=null&&r.b!=null&&r.a!==0?(r.b-r.a)/r.a*100:null;
    const better=delta!=null&&(r.lower?delta<-.1:delta>.1);
    return <tr key={r.label}><th>{r.label}</th><td>{r.format(r.a)}</td><td>{r.format(r.b)}</td><td><span className={better?'delta-better':delta!=null&&Math.abs(delta)>.1?'delta-worse':''}>{delta==null?'—':Math.abs(delta)<.1?'Similar':`${delta>0?'+':''}${delta.toFixed(1)}%`}</span></td></tr>;
  })}<tr><th>Requests finished / received</th><td>{basic?`${basic.completed_requests} / ${basic.injected_requests}`:'—'}</td><td>{llmd?`${llmd.completed_requests} / ${llmd.injected_requests}`:'—'}</td><td>{result?'All outcomes included':'—'}</td></tr><tr><th>Failed / unfinished</th><td>{basic?`${basic.failed_requests??0} / ${(basic.still_queued??0)+(basic.still_running??0)}`:'—'}</td><td>{llmd?`${llmd.failed_requests??0} / ${(llmd.still_queued??0)+(llmd.still_running??0)}`:'—'}</td><td>Lower is better</td></tr></tbody></table></div>;
}

function RequestDetail({side,requestId,current,time}: {side:Side;requestId:string;current?:Event;time:number}) {
  const metric=side.metrics.requests?.find(r=>r.requestID===requestId);
  const routing=side.playback.decisions.Routings?.find(r=>r.RequestID===requestId);
  const events=side.playback.events.filter(e=>e.requestId===requestId);
  const arrival=events.find(e=>e.kind==='arrived')?.timeUs??0;
  let queueStart: number | undefined, queueWait = 0;
  for (const event of events) { if (event.kind === 'queued' || event.kind === 'preempted') queueStart = event.timeUs; if (queueStart != null && ['processing','timed_out'].includes(event.kind)) { queueWait += event.timeUs - queueStart; queueStart = undefined; } }
  return <div className={`detail-side ${side.policy}`}><h3>{side.policy==='basic'?'Basic':'llm-d'}</h3><StageTag event={current}/><dl><div><dt>Assigned to</dt><dd>{routing?.Clock!=null&&routing.Clock<=time?`Instance ${Number(routing.ChosenInstance.match(/\d+$/)?.[0]??0)+1}`:'Not routed yet'}</dd></div><div><dt>Queue wait · full run</dt><dd>{formatMs(queueWait / 1000)}</dd></div><div><dt>First token · full run</dt><dd>{formatMs(metric?.ttft_ms)}</dd></div></dl>
    <ol className="event-timeline">{events.filter(e=>e.kind!=='preempted').map((e,i)=><li className={e.timeUs<=time?'passed':''} key={i}><span>{stageLabel[e.kind]}</span><time>+{formatMs((e.timeUs-arrival)/1000)}</time></li>)}</ol>
    <details className="routing-detail"><summary>Recorded routing decision</summary>{routing?<><p>{side.policy==='basic'?'Random selection among available endpoints.':'Selected by the configured weighted endpoint scores. Scores are preferences, not predicted latency.'}</p>{routing.Scores&&<ul>{Object.entries(routing.Scores).map(([id,score])=><li key={id}><span>{id}{id===routing.ChosenInstance?' · selected':''}</span><strong>{score.toFixed(3)}</strong></li>)}</ul>}</>:<p>No routing record available.</p>}</details>
  </div>;
}
