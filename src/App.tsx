import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Comparison, Config, DeploymentOptions, Event, Side, Transfer } from './types';
import { assessComparison, defaultTargets, queueIntervals, validTargets } from './analysis';
import type { PhaseComparison } from './analysis';
import { ResultsSummary } from './ResultsSummary';
import { SimulationCluster } from './SimulationCluster';
import { LiveComparison } from './LiveComparison';
import { buildPlaybackComparison } from './comparisonPlayback';
import { FieldLabel } from './FieldLabel';
import { inputHelp } from './inputHelp';
import { eventLabel, instanceLabel, formatMs, formatNumber, requestKey, requestLabel, requestStates, sessionDurations } from './playback';

const defaults: Config = { workload: 'chat', model: 'llama-3.1-8b-instruct', hardware: 'h100', instances: 4, disaggregated: false, prefillInstances: 2, fabric: 'ib-400g', requests: 256, rate: 40, inputTokens: 256, outputTokens: 256, prefixTokens: 512, seed: 42, sessions: 16, turns: 4, thinkTimeMs: 500, meanStartMs: 1000 };
const workloadPresets = {
  chat: {label: 'Chat', description: 'Short prompts, streaming replies', inputTokens: 256, outputTokens: 256, prefixTokens: 512, requests: 256, rate: 40},
  summarization: {label: 'Summarization', description: 'Long documents, shorter answers', inputTokens: 4096, outputTokens: 512, prefixTokens: 0, requests: 256, rate: 40},
  code: {label: 'Code generation', description: 'Repository context, long outputs', inputTokens: 1024, outputTokens: 2048, prefixTokens: 2048, requests: 64, rate: 12},
  agents: {label: 'Multi-turn agents', description: 'Repeated context, sequential turns', inputTokens: 256, outputTokens: 256, prefixTokens: 1024, requests: 64, rate: 16},
};

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
  const [targets, setTargets] = useState(defaultTargets);
  const assessment = useMemo(() => result ? assessComparison(result, targets) : null, [result, targets]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [deployments, setDeployments] = useState<DeploymentOptions>();
  const [error, setError] = useState('');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'simulation' | 'results'>('simulation');
  const inspectorHeading = useRef<HTMLHeadingElement>(null);
  const pendingInspection = useRef(false);
  const requestController = useRef<AbortController | null>(null);
  const end = result?.endTimeUs ?? 1;
  const changed = !!result && (Object.keys(config) as (keyof Config)[]).some(key => config[key] !== result.config[key]);
  const agents = config.workload === 'agents';
  const contextBudget = config.prefixTokens + 2 * config.turns * (config.inputTokens + config.outputTokens);
  const contextError = agents && contextBudget > (deployments?.contextLimit ?? 32768);
  const selectedModel = deployments?.models.find(model => model.id === config.model);
  const selectedHardware = deployments?.hardware.find(hardware => hardware.id === config.hardware);
  const viewConfig = result?.config ?? config;
  const networkLabel = deployments?.networks.find(n => n.id === viewConfig.fabric)?.label ?? viewConfig.fabric;
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
    if (!playing || !result || activeTab !== 'simulation') return;
    let last = performance.now(), frame = 0;
    function tick(now: number) {
      const elapsed = Math.min(now - last, 250) * 1000 * speed;
      last = now;
      setTime(t => Math.min(t + elapsed, end));
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, result, end, activeTab]);
  useEffect(() => { if (time >= end) setPlaying(false); }, [time, end]);
  useEffect(() => {
    if (activeTab !== 'simulation' || !pendingInspection.current) return;
    pendingInspection.current = false;
    inspectorHeading.current?.focus({preventScroll: true});
    inspectorHeading.current?.scrollIntoView({block: 'start'});
  }, [activeTab, selected, time]);

  async function run() {
    setBusy(true); setError(''); setPlaying(false); setActiveTab('simulation');
    const ctrl = new AbortController(); requestController.current = ctrl;
    try {
      const response = await fetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config), signal: ctrl.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Simulation failed. Try a smaller workload.');
      setResult(data); setTime(0); setSearch(''); setPlaying(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      const first = data.basic.playback.events.find((e: Event) => e.kind === 'arrived');
      setSelected(first ? requestKey(first) : '');
    } catch (e) { if (e instanceof Error && e.name !== 'AbortError') setError(e.message); }
    finally { setBusy(false); }
  }
  function update<K extends keyof Config>(key: K, value: Config[K]) { setConfig(c => ({ ...c, [key]: value })); }
  function selectModel(modelId: string) {
    const model = deployments?.models.find(option => option.id === modelId);
    if (!model) return;
    setConfig(c => ({ ...c, model: modelId, hardware: model.hardwareIds.includes(c.hardware) ? c.hardware : model.hardwareIds[0] }));
  }
  function preset(workload: Config['workload']) {
    const {inputTokens, outputTokens, prefixTokens, requests, rate} = workloadPresets[workload];
    setConfig(c => ({...c, workload, inputTokens, outputTokens, prefixTokens, requests, rate, sessions: 16, turns: 4, thinkTimeMs: 500, meanStartMs: 1000}));
  }
  function inspectRequest(key: string) {
    setSelected(key); setPlaying(false);
    inspectorHeading.current?.focus({preventScroll: true});
    inspectorHeading.current?.scrollIntoView({block: 'start'});
  }
  function inspectTransfer(side: Side, transfer: Transfer) {
    const request = side.playback.events.find(e => e.kind === 'arrived' && e.requestId === transfer.requestId);
    if (request) setSelected(requestKey(request));
    setTime(transfer.startUs + (transfer.endUs - transfer.startUs) / 2);
    setPlaying(false);
  }
  function inspectEvidence(evidence: NonNullable<PhaseComparison['evidence']>) {
    pendingInspection.current = true;
    setActiveTab('simulation');
    setSelected(evidence.key); setTime(evidence.timeUs); setPlaying(false);
  }
  function selectTab(tab: 'simulation' | 'results') {
    setActiveTab(tab);
    if (tab === 'results') setPlaying(false);
  }
  function download() {
    if (!result || !assessment) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({...result, assessment}, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `llmd-comparison-${result.id}.json`; link.click(); URL.revokeObjectURL(url);
  }
  const allRequests = useMemo(() => result?.basic.playback.events.filter(e => e.kind === 'arrived') ?? [], [result]);
  const filtered = allRequests.filter(e => `${requestLabel(e)} ${e.requestId}`.toLowerCase().includes(search.toLowerCase()));
  const states = useMemo(() => ({ basic: requestStates(result?.basic.playback.events ?? [], time), llmd: requestStates(result?.llmd.playback.events ?? [], time) }), [result, time]);
  const playbackComparison = useMemo(() => result ? buildPlaybackComparison(result) : undefined, [result]);
  const visibleRequests = filtered.slice(0, 24);
  const selectedEvent = allRequests.find(e => requestKey(e) === selected);
  const sessionTurns = selectedEvent?.sessionId ? allRequests.filter(e => e.sessionId === selectedEvent.sessionId).sort((a,b) => a.roundIndex-b.roundIndex) : [];

  return <div className="app">
    <header className="topbar">
      <a className="brand" href="/" aria-label="llm-d simulator home"><Icon name="route" size={25} /><strong>llm-d</strong><span>/ simulator</span></a>
      <div className="topbar-meta"><span className={`connection ${ready ? 'connected' : ''}`}>{ready ? 'BLIS connected' : 'Connecting to BLIS'}</span><a href="https://github.com/sue-kim/llm-d-simul" target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a></div>
    </header>
    <div className="workspace">
      <aside className="settings">
        <form onSubmit={e => { e.preventDefault(); void run(); }}>
          <div className="settings-scroll">
          <fieldset disabled={busy || !ready}>
            <h2>Workload</h2>
            <PresetPicker id="workload" label="Workload" className="workload-picker" value={config.workload} options={(Object.keys(workloadPresets) as Config['workload'][]).map(id => ({id, ...workloadPresets[id]}))} onChange={preset} disabled={busy || !ready} />
            <div className="paired-fields"><NumberField label={agents ? 'New input / turn' : 'Input tokens'} help={agents ? inputHelp.newInput : inputHelp.inputTokens} value={config.inputTokens} min={16} max={8192} onChange={v => update('inputTokens', v)} /><NumberField label={agents ? 'Output / turn' : 'Output tokens'} help={agents ? inputHelp.turnOutput : inputHelp.outputTokens} value={config.outputTokens} min={16} max={2048} onChange={v => update('outputTokens', v)} /></div>
            {agents ? <>
              <div className="paired-fields"><NumberField label="Agent sessions" help={inputHelp.sessions} value={config.sessions} min={1} max={64} onChange={v => update('sessions', v)} /><NumberField label="Turns / session" help={inputHelp.turns} value={config.turns} min={2} max={8} onChange={v => update('turns', v)} /></div>
              <p className="workload-note">{config.sessions * config.turns} requests · {config.sessions} independent sessions</p>
              {contextError && <p className="context-error" role="alert">Context could reach {contextBudget.toLocaleString()} tokens. Reduce turns or token lengths to stay within {(deployments?.contextLimit ?? 32768).toLocaleString()}.</p>}
            </> : <>
            <div className="traffic-setting">
            <div className="range-label"><FieldLabel htmlFor="traffic" label="Traffic" help={inputHelp.traffic} /><strong>{config.rate} <span>req/s</span></strong></div>
            <input id="traffic" type="range" min="1" max="300" value={config.rate} onChange={e => update('rate', +e.target.value)} />
            </div>
            <NumberField label="Requests" help={inputHelp.requests} value={config.requests} min={16} max={1024} onChange={v => update('requests', v)} />
            </>}
            <details className="workload-options" onInvalidCapture={event => { event.currentTarget.open = true; }}>
              <summary>More options</summary>
              <div>
                <NumberField label={agents ? 'Initial context tokens' : 'Shared prefix tokens'} help={agents ? inputHelp.initialContext : inputHelp.prefix} value={config.prefixTokens} min={0} max={4096} onChange={v => update('prefixTokens', v)} />
                {agents && <>
                  <NumberField label="Pause between turns (ms)" help={inputHelp.pause} value={config.thinkTimeMs} min={0} max={5000} onChange={v => update('thinkTimeMs', v)} />
                  <NumberField label="Mean start delay (ms)" help={inputHelp.startDelay} value={config.meanStartMs} min={10} max={30000} onChange={v => update('meanStartMs', v)} />
                </>}
                <NumberField label="Seed" help={inputHelp.seed} value={config.seed} min={0} max={1000000} onChange={v => update('seed', v)} />
              </div>
            </details>
            <div className="settings-divider" />
            <h2>Hardware</h2><p className="section-help">Shared by both sides.</p>
            <div className="model-setting">
              <div className="field"><label htmlFor="model-trigger">Model</label><PresetPicker id="model" label="Model" value={config.model} options={deployments?.models ?? [{id: config.model, label: 'Loading models…'}]} onChange={selectModel} disabled={busy || !ready} /></div>
            </div>
            <div className="gpu-setting">
              <div className="field"><label htmlFor="gpu-trigger">GPU</label><PresetPicker id="gpu" label="GPU" value={config.hardware} options={deployments ? deployments.hardware.map(hardware => ({...hardware, description: `${hardware.memoryGiB.toFixed(2)} GiB modeled memory`, disabled: !selectedModel?.hardwareIds.includes(hardware.id)})) : [{id: config.hardware, label: 'Loading GPUs…'}]} onChange={value => update('hardware', value)} disabled={busy || !ready} compact /></div>
            </div>
            <div className="field"><FieldLabel htmlFor="gpu-budget-trigger" label="GPUs per side" help={inputHelp.gpuBudget} /><PresetPicker id="gpu-budget" label="GPUs per side" className="gpu-budget-picker" value={String(config.instances)} options={[2,3,4,5,6,7,8].map(n => ({id: String(n), label: `${n} GPUs · ${n} instances`}))} onChange={value => setConfig(c => ({...c, instances: +value, prefillInstances: Math.min(c.prefillInstances, +value - 1)}))} disabled={busy || !ready} /></div>
          </fieldset>
          </div>
          <div className="settings-actions">
            <button className="run-button" type="submit" disabled={!ready || busy || contextError}>{busy ? <span className="spinner" /> : <Icon name="play" />} {busy ? 'Running BLIS…' : 'Run comparison'}</button>
            <p className="run-note">Runs locally on your CPU. No GPUs required.</p>
          </div>
        </form>
      </aside>

      <main>
        <div className="main-scroll">
        <div className="page-heading"><div><h1>Compare inference routing</h1></div><button className="text-button export" disabled={!result || busy || !validTargets(targets)} onClick={download}><Icon name="download" />Export run</button></div>
        {error && <div className="error" role="alert"><strong>Couldn’t complete the comparison</strong><p>{error}</p></div>}
        <div className="comparison-context"><span className="verified-dot" /><span>{result ? `${workloadPresets[result.config.workload].label} · ${result.fairness.matchedRequests} matched requests · ${result.deployment.model.label} · ${result.config.instances} ${resultHardware} GPUs per side` : 'Matched requests, model, hardware, and engine settings'}</span><span className="synthetic-label">Synthetic workload</span></div>
        <details className="comparison-options">
          <summary><span>llm-d features &amp; pools</span><span className="layout-summary">{config.disaggregated ? `${config.prefillInstances} prefill / ${config.instances - config.prefillInstances} decode` : 'Combined instances'}</span></summary>
          <div className="comparison-options-content">
            <section className="routing-feature" aria-labelledby="llmd-features-title">
              <h3 id="llmd-features-title">Inference-aware routing</h3>
              <p>llm-d scores {config.disaggregated ? 'endpoints within each pool' : 'instances'} using queues and prefix cache{config.disaggregated ? '' : ', active load, and KV usage'}. Basic routing picks randomly.</p>
            </section>
            <fieldset className="pool-settings" disabled={busy || !ready}>
              <legend>Shared prefill / decode pools</legend>
              <p className="feature-description">The same layout and total GPU budget apply to both sides.</p>
              <div className="pool-fields">
                <div className="field"><FieldLabel htmlFor="processing-layout" label="Processing layout" help={inputHelp.layout} /><select id="processing-layout" value={config.disaggregated ? 'separate' : 'combined'} onChange={e => update('disaggregated', e.target.value === 'separate')}><option value="combined">Combined prefill + decode</option><option value="separate">Separate prefill / decode pools</option></select></div>
                {config.disaggregated && <>
                  <div className="field"><FieldLabel htmlFor="prefill-allocation" label="Prefill allocation" help={inputHelp.prefill} /><select id="prefill-allocation" value={config.prefillInstances} onChange={e => update('prefillInstances', +e.target.value)}>{Array.from({length: config.instances - 1}, (_, i) => i + 1).map(n => <option key={n} value={n}>{n} prefill · {config.instances - n} decode</option>)}</select></div>
                  <div className="field"><FieldLabel htmlFor="transfer-network" label="KV transfer network" help={inputHelp.network} /><select id="transfer-network" value={config.fabric} onChange={e => update('fabric', e.target.value)}>{deployments?.networks.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</select></div>
                </>}
              </div>
              {config.disaggregated && <p className="feature-description">{config.prefillInstances} prefill + {config.instances - config.prefillInstances} decode = {config.instances} GPUs per side. One GPU per node; simultaneous KV transfers share bandwidth.</p>}
            </fieldset>
          </div>
        </details>
        {result?.config.workload === 'agents' && <p className="session-note">{result.config.sessions} agents × {result.config.turns} turns. Same starting contexts and token content; each next turn waits for its own response + {result.config.thinkTimeMs} ms. Later arrivals can differ between sides.</p>}
        {viewConfig.disaggregated && <p className="session-note">Separate pools · {viewConfig.prefillInstances} prefill + {viewConfig.instances - viewConfig.prefillInstances} decode = {viewConfig.instances} GPUs on each side · {networkLabel}. Both strategies route within the same pool layout.</p>}
        {changed && <p className="changed-note" role="status">Settings changed. Run again to update the comparison below.</p>}
        {busy && <div className="busy-note" role="status"><span className="spinner" /><span>Computing both BLIS runs. Playback will be ready when they finish.</span></div>}
        <div className="comparison-tabs" role="tablist" aria-label="Comparison views">
          {(['simulation', 'results'] as const).map(tab => <button type="button" role="tab" key={tab} id={`${tab}-tab`} aria-controls={`${tab}-panel`} aria-selected={activeTab === tab} tabIndex={activeTab === tab ? 0 : -1} onClick={() => selectTab(tab)} onKeyDown={event => {
            const next = event.key === 'Home' ? 'simulation' : event.key === 'End' ? 'results' : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? (tab === 'simulation' ? 'results' : 'simulation') : null;
            if (!next) return;
            event.preventDefault(); selectTab(next); document.getElementById(`${next}-tab`)?.focus();
          }}>{tab === 'simulation' ? 'Simulation' : 'Results'}</button>)}
        </div>
        <div id="simulation-panel" role="tabpanel" aria-labelledby="simulation-tab" hidden={activeTab !== 'simulation'} tabIndex={0}>
        {result && playbackComparison && <LiveComparison result={result} model={playbackComparison} time={time} onJump={timeUs => { setTime(timeUs); setPlaying(false); }} />}
        <section className="comparison" aria-label="Side-by-side simulation">
          <SimulationCluster key={`basic-${result?.id ?? config.disaggregated}`} title="Basic load balancing" description={viewConfig.disaggregated ? 'Random selection within each pool' : 'Random endpoint selection'} variant="basic" side={result?.basic} config={viewConfig} network={networkLabel} onTransfer={inspectTransfer} hardware={resultHardware} states={states.basic} instanceScale={playbackComparison?.instanceScale ?? 1} time={time} selected={selected} onSelect={inspectRequest} onPause={() => setPlaying(false)} />
          <SimulationCluster key={`llmd-${result?.id ?? config.disaggregated}`} title="llm-d routing" description="In-flight load, queue, and cache scoring" variant="llmd" side={result?.llmd} config={viewConfig} network={networkLabel} onTransfer={inspectTransfer} hardware={resultHardware} states={states.llmd} instanceScale={playbackComparison?.instanceScale ?? 1} time={time} selected={selected} onSelect={inspectRequest} onPause={() => setPlaying(false)} />
        </section>
        <p className="simulation-help">{result ? `Instance bars share a fixed 0–${playbackComparison?.instanceScale ?? 1} request scale. Select a lane or count to pause and inspect.` : 'Run a comparison to follow requests through each instance.'}</p>
        <section className="inspection-section" aria-labelledby="inspector-title">
          <div className="section-heading"><h2 id="inspector-title" ref={inspectorHeading} tabIndex={-1}>Inspect a request</h2><span>Select a request on either side to follow its path.</span></div>
          <div className="inspection-grid">
            <div className="request-list"><label className="search-label">Find request<input type="search" placeholder={result?.config.workload === 'agents' ? 'Search agent or turn' : 'Search request ID'} value={search} onChange={e => setSearch(e.target.value)} disabled={!result} /></label>
              <div className="request-table-head"><span>Request</span><span>Basic</span><span>llm-d</span></div>
              <div className="request-rows">{visibleRequests.map(e => <button key={requestKey(e)} aria-pressed={selected === requestKey(e)} onClick={() => setSelected(requestKey(e))}><span className="request-id">{requestLabel(e)}</span><StageTag event={states.basic.get(requestKey(e))} /><StageTag event={states.llmd.get(requestKey(e))} /></button>)}{!visibleRequests.length && <p className="empty-copy">{result ? 'No requests match this search.' : 'Requests appear here after your first run.'}</p>}</div>
              {!!allRequests.length && <p className="table-foot">Showing {visibleRequests.length} of {filtered.length} requests. Search to inspect any request.</p>}
            </div>
            <div className="request-detail">{result && selectedEvent ? <>
              <div className="detail-title"><strong>{requestLabel(selectedEvent)}</strong><span>{selectedEvent.inputTokens.toLocaleString()} input · {selectedEvent.outputTokens.toLocaleString()} output tokens</span></div>
              {sessionTurns.length > 0 && <>
                <nav className="turn-navigation" aria-label="Session turns">{sessionTurns.map(e => <button key={requestKey(e)} aria-pressed={requestKey(e) === selected} onClick={() => setSelected(requestKey(e))}>Turn {e.roundIndex + 1}</button>)}</nav>
                <div className="context-breakdown"><span><b>{(selectedEvent.historyTokens ?? 0).toLocaleString()}</b> {selectedEvent.roundIndex === 0 ? 'initial context' : 'retained context'}</span><span>+ <b>{(selectedEvent.inputTokens - (selectedEvent.historyTokens ?? 0)).toLocaleString()}</b> new input</span><span>→ <b>{selectedEvent.outputTokens.toLocaleString()}</b> output tokens</span></div>
              </>}
              <div className="detail-sides"><RequestDetail side={result.basic} requestId={selected} current={states.basic.get(selected)} time={time} onTransfer={inspectTransfer} /><RequestDetail side={result.llmd} requestId={selected} current={states.llmd.get(selected)} time={time} onTransfer={inspectTransfer} /></div>
            </> : <div className="inspector-empty"><Icon name="route" size={30} /><h3>See what a request waited for.</h3><p>Inspect its recorded queue time, assigned instance, and routing decision in both runs.</p></div>}</div>
          </div>
        </section>
        </div>
        <div id="results-panel" role="tabpanel" aria-labelledby="results-tab" hidden={activeTab !== 'results'} tabIndex={0}>
          <section className="results-section" aria-labelledby="results-title"><div className="section-heading"><h2 id="results-title">Full run results</h2><span>{result ? 'Completed-request latency · common throughput window' : 'Run a comparison to see measured simulation outputs'}</span></div>
            <ResultsSummary result={result} targets={targets} assessment={assessment} onTargets={setTargets} onInspect={inspectEvidence}/>
            <Results result={result} />
          </section>
        </div>
        <details className="methodology"><summary>How this comparison works <span>BLIS v0.12.0</span></summary><div>
          <p>Basic routing uses random selection. llm-d balances in-flight requests (weight 2) alongside engine queues, KV occupancy, and prefix-cache reuse (weight 1 each). Dispatched requests count as load while waiting for input preparation and admission. Combined instances use the upstream in-flight load configuration; separate pools adapt that scoring mix to both prefill and decode. Both execute inside BLIS’s embedded llm-d router, with the same engine settings and cold caches. These are simulated policy results, with zero router decision time.</p>
          <p>Input and output lengths use bounded synthetic distributions with 25% standard deviation. Shared context is added to each input. Chat, summarization, and code generation are editable synthetic examples using BLIS workload distributions. Code generation emphasizes long output sequences; no real code is executed or evaluated.</p>
          <p>Multi-turn agents use BLIS closed-loop sessions. Each session has its own initial context, accumulates prior input and output context, and waits for the prior completion plus the configured pause (engine completion for combined instances; parent response completion for separate pools). Session starts and token hashes match across policies; later arrival times respond to each policy’s performance. The pinned BLIS session manager retains one fewer output token per turn than its generated-token metric; the inspector shows the actual retained amount. Pauses stand in for work between model calls; tool execution, branching, and reasoning quality are not modeled. Configurations that could exceed the engine context limit are refused.</p>
          <p>Model and GPU options come from the pinned BLIS catalog and have been exercised in this simulator. All use BF16 weights and KV cache, one GPU per instance, and a 32,768-token engine limit. GPU memory values follow the catalog’s modeled capacity in GiB. These checks establish compatibility; accuracy depends on BLIS’s coefficient coverage for the selected deployment.</p>
          <p>Separate pools divide the total GPU budget; they do not add GPUs. Both sides use the same split, one GPU per node, and the selected catalog network. BLIS prices KV pulls with NixlConnector and network contention enabled. Catalog network bandwidth is a nominal specification, not a measured deployment rate. Transfer markers follow recorded times, including decode cache reuse and waiting for KV space. The inspector reports the parent response and counts each request once; raw child events remain in the export.</p>
          <p>Latency targets are evaluated locally against each parent request’s BLIS first-token and full-response times. A request must complete and meet both inclusive limits to pass. Failed, unfinished, unmeasured, and un-emitted planned agent turns count as misses. Targets can be edited without rerunning BLIS and are saved with the assessment in the export. Timing explanations compare matched completed requests, using averages rather than subtracting percentiles.</p>
          <p>Request transitions are recorded from the engine. Gauges use snapshots approximately every 50 ms. “Processing” includes prompt processing; “streaming” begins at the recorded first token. Full run metrics remain fixed while you replay.</p>
          {result && <><p>Run <code>{result.id}</code> · Seed {result.config.seed} · {result.fairness.mode === 'matched-sessions' ? 'Matched sessions, token content, and context continuity verified.' : 'Identical arrivals and token content verified.'}</p><dl className="pins">{Object.entries(result.provenance.repositories).map(([name,pin]) => <div key={name}><dt>{name}</dt><dd><a target="_blank" rel="noreferrer" href={`https://github.com/inference-sim/${name}/commit/${pin.commit}`}>{pin.tag} · {pin.commit.slice(0,12)}</a></dd></div>)}</dl><p>Kernel inputs include measured, vendor-specified, and assumed coefficients. Full provenance and raw decisions are included in the exported run.</p></>}
          <a href="https://github.com/inference-sim/inference-sim/blob/v0.12.0/docs/guide/routing.md" target="_blank" rel="noreferrer">Read the BLIS routing methodology ↗</a>
        </div></details>
        <footer>Built to explore tradeoffs. Validate promising configurations against your deployment.</footer>
        </div>
        {activeTab === 'simulation' && <div className="playback-dock">
          <div className="playback-controls" role="group" aria-label="Simulation playback">
            <button className="play-button" aria-label={playing ? 'Pause playback' : 'Play playback'} disabled={!result || busy} onClick={() => { if (time >= end) setTime(0); setPlaying(!playing); }}><Icon name={playing ? 'pause' : 'play'} /></button>
            <button className="icon-button" aria-label="Restart playback" disabled={!result || busy} onClick={() => {setTime(0); setPlaying(false);}}><Icon name="reset" /></button>
            <button className="icon-button" aria-label="Step forward 100 milliseconds" disabled={!result || busy} onClick={() => {setPlaying(false); setTime(t => Math.min(t + 100000, end));}}><Icon name="step" /></button>
            <span className="clock">{(time / 1e6).toFixed(2)} <small>/ {result ? (end / 1e6).toFixed(2) : '0.00'} s</small></span>
            <input type="range" aria-label="Simulation time" min="0" max={end} step="1000" value={time} disabled={!result || busy} onChange={e => {setPlaying(false); setTime(+e.target.value);}} />
            <select aria-label="Playback speed" value={speed} onChange={e => setSpeed(+e.target.value)}>{[0.25,0.5,1,2,4].map(s => <option value={s} key={s}>{s}×</option>)}</select>
            <span className="playback-caption">Simulated time</span>
          </div>
        </div>}
      </main>
    </div>
  </div>;
}

type PresetOption<Value extends string> = {id:Value;label:string;description?:string;disabled?:boolean};

function PresetPicker<Value extends string>({id,label,value,options,onChange,disabled,className='',compact=false}: {id:string;label:string;value:Value;options:PresetOption<Value>[];onChange:(value:Value)=>void;disabled:boolean;className?:string;compact?:boolean}) {
  const [open,setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = options.find(option => option.id === value);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const content = menu.current;
    const anchor = trigger.current.getBoundingClientRect();
    const margin = 12, gap = 6;
    content.style.width = `${Math.min(anchor.width, window.innerWidth - margin * 2)}px`;
    // The top layer escapes the settings scroller and the fixed action footer.
    content.showPopover();
    const height = content.getBoundingClientRect().height;
    const below = Math.max(0, window.innerHeight - anchor.bottom - gap - margin);
    const above = Math.max(0, anchor.top - gap - margin);
    const opensAbove = height > below && above > below;
    const available = opensAbove ? above : below;
    content.style.maxHeight = `${Math.min(window.innerHeight * 0.6, available)}px`;
    content.style.left = `${Math.max(margin, Math.min(anchor.left, window.innerWidth - content.getBoundingClientRect().width - margin))}px`;
    content.style.top = `${opensAbove ? anchor.top - gap - Math.min(height, available) : anchor.bottom + gap}px`;
    const dismiss = (event: globalThis.Event) => {
      if (event.target instanceof Node && content.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const selectedButton = menu.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]:not(:disabled)') ?? menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    selectedButton?.focus({preventScroll:true});
    if (selectedButton && menu.current) {
      const optionBounds = selectedButton.getBoundingClientRect();
      const menuBounds = menu.current.getBoundingClientRect();
      if (optionBounds.bottom > menuBounds.bottom) menu.current.scrollTop += optionBounds.bottom - menuBounds.bottom + 8;
      else if (optionBounds.top < menuBounds.top) menu.current.scrollTop -= menuBounds.top - optionBounds.top + 8;
    }
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown',dismiss);
    return () => document.removeEventListener('pointerdown',dismiss);
  },[open]);
  useEffect(() => { if (disabled) setOpen(false); },[disabled]);
  return <div className={`preset-picker ${className}`} ref={root} onBlur={event=>{
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event=>{
    if (event.key==='Escape' && open) {
      event.preventDefault(); setOpen(false); trigger.current?.focus();
    }
  }}>
    <button type="button" id={`${id}-trigger`} className="preset-trigger" ref={trigger} disabled={disabled} aria-label={`${label}: ${selected?.label ?? value}`} aria-expanded={open} aria-controls={`${id}-options`} onClick={()=>setOpen(v=>!v)} onKeyDown={event=>{
      if (event.key==='ArrowDown' || event.key==='ArrowUp') {event.preventDefault();setOpen(true);}
    }}><span><strong>{selected?.label ?? value}</strong>{!compact && selected?.description && <span>{selected.description}</span>}</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
    {open && <div id={`${id}-options`} ref={menu} popover="manual" className="preset-options preset-menu" role="group" aria-label={`${label} options`} onKeyDown={event=>{
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key==='ArrowDown'?(index+1)%buttons.length:event.key==='ArrowUp'?(index-1+buttons.length)%buttons.length:event.key==='Home'?0:event.key==='End'?buttons.length-1:-1;
      if (next>=0) {event.preventDefault();buttons[next]?.focus();}
    }}>
      {options.map(option=><button type="button" key={option.id} disabled={option.disabled} aria-pressed={value===option.id} onClick={()=>{onChange(option.id);setOpen(false);trigger.current?.focus();}}><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</button>)}
    </div>}
  </div>;
}

function NumberField({ label, help, value, min, max, onChange }: {label: string; help?: string; value: number; min: number; max: number; onChange: (n: number) => void}) {
  const id = useId();
  return <div className="field"><FieldLabel label={label} htmlFor={id} help={help} /><input id={id} type="number" required value={value} min={min} max={max} step="1" onChange={e => onChange(e.target.value === '' ? 0 : +e.target.value)} /></div>;
}

function StageTag({event}: {event?: Event}) { return <span className={`stage ${event?.kind ?? 'pending'}`}>{event ? eventLabel(event) : 'Not arrived'}</span>; }

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
  if (result?.config.disaggregated) {
    rows.push(
      {label: 'KV transfer time · median', a: basic?.pd?.transfer_time_p50_ms, b: llmd?.pd?.transfer_time_p50_ms, format: formatMs, lower: true},
      {label: 'KV transfer contention delay · p90', a: basic?.pd?.transfer_queue_delay_p90_ms, b: llmd?.pd?.transfer_queue_delay_p90_ms, format: formatMs, lower: true},
    );
  }
  if (result?.config.workload === 'agents') {
    const p95 = (side: Side) => {
      const durations = [...sessionDurations(side).values()].filter(s => s.turns === result.config.turns).map(s => s.end-s.start).sort((a,b) => a-b);
      return durations.length ? durations[Math.ceil(durations.length * .95)-1] : undefined;
    };
    rows.push({label: 'Agent session time · p95', a: p95(result.basic), b: p95(result.llmd), format: formatMs, lower: true});
  }
  return <div className="metrics-table"><table><thead><tr><th>Metric</th><th>Basic</th><th>llm-d</th><th>Difference</th></tr></thead><tbody>{rows.map(r=>{
    const delta=r.a!=null&&r.b!=null&&r.a!==0?(r.b-r.a)/r.a*100:null;
    const better=delta!=null&&(r.lower?delta<-.1:delta>.1);
    return <tr key={r.label}><th>{r.label}</th><td>{r.format(r.a)}</td><td>{r.format(r.b)}</td><td><span className={better?'delta-better':delta!=null&&Math.abs(delta)>.1?'delta-worse':''}>{delta==null?'—':Math.abs(delta)<.1?'Similar':`${delta>0?'+':''}${delta.toFixed(1)}%`}</span></td></tr>;
  })}<tr><th>Requests finished / received</th><td>{basic?`${basic.completed_requests} / ${basic.injected_requests}`:'—'}</td><td>{llmd?`${llmd.completed_requests} / ${llmd.injected_requests}`:'—'}</td><td>{result?'All outcomes included':'—'}</td></tr><tr><th>Failed / unfinished</th><td>{basic?`${basic.failed_requests??0} / ${(basic.still_queued??0)+(basic.still_running??0)}`:'—'}</td><td>{llmd?`${llmd.failed_requests??0} / ${(llmd.still_queued??0)+(llmd.still_running??0)}`:'—'}</td><td>Lower is better</td></tr></tbody></table></div>;
}

function RequestDetail({side,requestId,current,time,onTransfer}: {side:Side;requestId:string;current?:Event;time:number;onTransfer:(side:Side,transfer:Transfer)=>void}) {
  const request = side.playback.events.find(e => e.kind === 'arrived' && requestKey(e) === requestId);
  const rawId = request?.requestId;
  const metric=side.metrics.requests?.find(r=>r.requestID===rawId);
  const routing=side.playback.decisions.Routings?.find(r=>r.RequestID===rawId);
  const events=side.playback.events.filter(e=>e.requestId===rawId);
  const arrival=events.find(e=>e.kind==='arrived')?.timeUs??0;
  const transfer = side.playback.transfers?.find(t => t.requestId === rawId);
  const prefillRouting = side.playback.decisions.PrefillRoutings?.find(r => r.ParentRequestID === rawId);
  const waits = {prefill: 0, decode: 0, combined: 0};
  for (const interval of queueIntervals(events)) {
    waits[interval.phase === 'prefill' ? 'prefill' : interval.phase === 'decode' ? 'decode' : 'combined'] += interval.endUs - interval.startUs;
  }
  const routed = routing?.Clock != null && routing.Clock <= time;
  const queueWait = waits.prefill + waits.decode + waits.combined;
  return <div className={`detail-side ${side.policy}`}><h3>{side.policy==='basic'?'Basic':'llm-d'}</h3>{!current && request?.sessionId && request.roundIndex > 0 ? <span className="stage pending">Waiting for prior turn</span> : <StageTag event={current}/>}<dl><div><dt>Arrives at · simulated time</dt><dd>{formatMs(arrival / 1000)}</dd></div>{transfer ? <>
      <div><dt>Prefill instance</dt><dd>{routed ? instanceLabel(transfer.prefillInstanceId) : 'Not routed yet'}</dd></div>
      <div><dt>Decode instance</dt><dd>{routed ? instanceLabel(transfer.decodeInstanceId) : 'Not routed yet'}</dd></div>
      <div><dt>Prefill queue · full run</dt><dd>{formatMs(waits.prefill / 1000)}</dd></div>
      <div><dt>KV space wait · full run</dt><dd>{formatMs((transfer.startUs-transfer.prefillCompleteUs)/1000)}</dd></div>
      <div><dt>KV transfer · full run</dt><dd>{formatMs((transfer.endUs-transfer.startUs)/1000)}</dd></div>
      <div><dt>KV blocks pulled / total</dt><dd>{transfer.pulledBlocks} / {transfer.blocks}</dd></div>
      <div><dt>Decode queue · full run</dt><dd>{formatMs(waits.decode / 1000)}</dd></div>
    </> : <><div><dt>Assigned to</dt><dd>{routed && routing ? instanceLabel(routing.ChosenInstance) : 'Not routed yet'}</dd></div><div><dt>Queue wait · full run</dt><dd>{formatMs(queueWait / 1000)}</dd></div></>}<div><dt>First token · full run</dt><dd>{formatMs(metric?.ttft_ms)}</dd></div></dl>
    {transfer && <button className="inspect-transfer" onClick={()=>onTransfer(side,transfer)}>Pause inside this KV transfer ↗</button>}
    <ol className="event-timeline">{events.filter(e=>e.kind!=='preempted').map((e,i)=><li className={e.timeUs<=time?'passed':''} key={i}><span>{eventLabel(e)}</span><time>+{formatMs((e.timeUs-arrival)/1000)}</time></li>)}</ol>
    <details className="routing-detail"><summary>Recorded routing decision</summary>{routing?<><p className="raw-request-id">BLIS request: {rawId}</p>{transfer && <p>Prefill: {prefillRouting?.ChosenInstance ?? transfer.prefillInstanceId}. Decode: {routing.ChosenInstance}. Scores below are for the decode pool. Transfers pull only blocks absent from its KV cache.</p>}<p>{side.policy==='basic'?'Random selection among available endpoints.':'Selected by the configured weighted endpoint scores. Scores are preferences, not predicted latency.'}</p>{routing.Scores&&<ul>{Object.entries(routing.Scores).map(([id,score])=><li key={id}><span>{id}{id===routing.ChosenInstance?' · selected':''}</span><strong>{score.toFixed(3)}</strong></li>)}</ul>}</>:<p>No routing record available.</p>}</details>
  </div>;
}
