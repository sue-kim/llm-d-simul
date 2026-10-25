import { useEffect, useRef, useState } from 'react';
import type { Config, Event, Side, Transfer } from './types';
import { eventLabel, formatMs, instanceLabel, requestKey, requestLabel, snapshotAt } from './playback';

type Selection = { instance: string; kind: 'queue' | 'running' | 'all' } | { kind: 'transfers' } | { kind: 'kv-wait' } | { kind: 'preparing' };
const queued = (event: Event) => event.kind === 'queued' || event.kind === 'preempted';
const running = (event: Event) => ['processing', 'streaming', 'prefilling', 'decoding'].includes(event.kind);

export function SimulationCluster({ title, description, variant, side, config, network, hardware, states, time, selected, onSelect, onPause, onTransfer }: {
  title: string; description: string; variant: 'basic' | 'llmd'; side?: Side; config: Config;
  network: string; hardware: string; states: Map<string, Event>; time: number; selected: string;
  onSelect: (key: string) => void; onPause: () => void; onTransfer: (side: Side, transfer: Transfer) => void;
}) {
  const [expanded, setExpanded] = useState<Selection>();
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!expanded) return;
    detailHeading.current?.focus({ preventScroll: true });
    detailHeading.current?.parentElement?.parentElement?.scrollIntoView({ block: 'nearest' });
  }, [expanded]);
  const current = [...states.values()];
  const preparing = current.filter(event => event.kind === 'arrived' || event.kind === 'routed');
  const snapshot = snapshotAt(side, time);
  const ids = side?.playback.snapshots.at(-1)?.InstanceSnapshots.map(instance => instance.ID)
    ?? Array.from({ length: config.instances }, (_, index) => `instance_${index}`);
  const role = (id: string) => side?.playback.pools?.[id] ?? (ids.indexOf(id) < config.prefillInstances ? 'prefill' : 'decode');
  const transfers = side?.playback.transfers ?? [];
  const inTransit = transfers.filter(transfer => transfer.startUs <= time && time < transfer.endUs);
  const waitingForSpace = current.filter(event => event.kind === 'kv_wait');
  const arrivals = new Map(side?.playback.events.filter(event => event.kind === 'arrived').map(event => [event.requestId, event]));
  const transferEvent = (transfer: Transfer) => arrivals.get(transfer.requestId);
  const featuredTransfer = inTransit.find(transfer => {
    const event = transferEvent(transfer);
    return event && requestKey(event) === selected;
  }) ?? inTransit[0];
  const featuredEvent = featuredTransfer && transferEvent(featuredTransfer);
  const progress = featuredTransfer ? (time - featuredTransfer.startUs) / (featuredTransfer.endUs - featuredTransfer.startUs) * 100 : 0;
  const nextTransfer = transfers.find(transfer => transfer.startUs > time) ?? transfers[0];
  const delivered = transfers.filter(transfer => transfer.endUs <= time).length;
  const finished = current.filter(event => event.kind === 'completed').length;
  const failed = current.filter(event => event.kind === 'timed_out' || event.kind === 'dropped').length;
  const detailId = `${variant}-pool-requests`;

  function reveal(selection: Selection) {
    onPause();
    detailTrigger.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    setExpanded(previous => JSON.stringify(previous) === JSON.stringify(selection) ? undefined : selection);
  }
  const isExpanded = (id: string, kind: Selection['kind']) => expanded && 'instance' in expanded && expanded.instance === id && expanded.kind === kind;
  const renderInstances = (poolIds: string[], name: string) => <div className={`instance-map ${poolIds.length === 1 ? 'single' : ''}`} role="group" aria-label={`${title}: ${name}`}>
    {poolIds.map(id => {
      const events = current.filter(event => event.instanceId === id);
      const queue = events.filter(queued), active = events.filter(running);
      const containsSelected = [...queue, ...active].some(event => requestKey(event) === selected);
      const transferring = featuredTransfer && [featuredTransfer.prefillInstanceId, featuredTransfer.decodeInstanceId].includes(id);
      const cache = Math.min(100, Math.max(0, (snapshot?.InstanceSnapshots.find(instance => instance.ID === id)?.KVUtilization ?? 0) * 100));
      const renderActivity = (requests: Event[], kind: 'queue' | 'running') => {
        const selectedRequest = requests.find(event => requestKey(event) === selected);
        const shown = requests.slice(0, 8);
        if (selectedRequest && !shown.includes(selectedRequest)) shown[shown.length - 1] = selectedRequest;
        return <button type="button" className={`instance-activity ${kind}`} disabled={!requests.length} aria-label={`${instanceLabel(id)}: ${requests.length} ${kind === 'queue' ? 'queued' : 'running'} requests`} aria-expanded={!!isExpanded(id, kind)} aria-controls={detailId} onClick={() => reveal({ instance: id, kind })}>
          <span className="activity-label"><span>{kind === 'queue' ? 'Queued' : 'Running'}</span><strong>{requests.length}</strong></span>
          <span className="activity-markers" aria-hidden="true">{shown.map(event => <i key={event.requestId} className={requestKey(event) === selected ? 'selected-marker' : ''} />)}{requests.length > shown.length && <span>+{requests.length - shown.length}</span>}</span>
        </button>;
      };
      return <div key={id} className={`instance-node ${containsSelected ? 'contains-request' : ''} ${transferring ? 'transfer-endpoint' : ''}`} role="group" aria-label={instanceLabel(id)}>
        <button type="button" className="instance-name" aria-expanded={!!isExpanded(id, 'all')} aria-controls={detailId} onClick={() => reveal({ instance: id, kind: 'all' })}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4" /><rect x="9" y="9" width="6" height="6" /></svg>
          {instanceLabel(id)}
        </button>
        {renderActivity(queue, 'queue')}
        {renderActivity(active, 'running')}
        <div className="node-cache-label"><span>KV cache</span><span>{cache.toFixed(1)}%</span></div>
        <div className="node-cache-meter" role="meter" aria-label={`${instanceLabel(id)} KV cache used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(cache.toFixed(1))}><span style={{ width: `${cache}%` }} /></div>
      </div>;
    })}
  </div>;

  const expandedInstance = expanded && 'instance' in expanded ? expanded.instance : undefined;
  const detailEvents = !expanded ? [] : expanded.kind === 'transfers'
    ? inTransit.map(transferEvent).filter((event): event is Event => !!event)
    : expanded.kind === 'kv-wait' ? waitingForSpace : expanded.kind === 'preparing' ? preparing
    : current.filter(event => event.instanceId === expanded.instance && (expanded.kind === 'queue' ? queued(event) : expanded.kind === 'running' ? running(event) : queued(event) || running(event)));
  const detailTitle = !expanded ? '' : expanded.kind === 'transfers' ? 'KV transfers in progress'
    : expanded.kind === 'kv-wait' ? 'Waiting for decode KV space' : expanded.kind === 'preparing' ? 'Preparing input'
    : `${instanceLabel(expanded.instance)} · ${expanded.kind === 'queue' ? 'Queued' : expanded.kind === 'running' ? 'Running' : 'Active requests'}`;

  return <article className={`cluster ${variant}`} aria-label={title}>
    <header className="cluster-title"><span className="policy-indicator" /><div><h2>{title}</h2><p>{description}</p></div><span className="gpu-count">{config.instances} × {hardware}</span></header>
    <div className="cluster-summary"><span><strong>{states.size}</strong> received</span><button type="button" disabled={!preparing.length} aria-expanded={expanded?.kind === 'preparing'} aria-controls={detailId} onClick={() => reveal({ kind: 'preparing' })}><strong>{preparing.length}</strong> preparing input</button><span><strong>{finished}</strong> finished</span>{failed > 0 && <span className="cluster-failed"><strong>{failed}</strong> failed</span>}</div>
    <div className="cluster-flow">
      {config.disaggregated ? <>
        <section className="flow-pool" aria-label="Prefill pool"><div className="flow-heading"><h3>Prefill</h3><span>Read input · {config.prefillInstances} GPUs</span></div>{renderInstances(ids.filter(id => role(id) === 'prefill'), 'Prefill pool')}</section>
        <section className="kv-handoff" aria-label="KV transfer">
          <div className="flow-heading"><h3><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 3v17m-6-6 6 6 6-6" /></svg>KV transfer</h3><button type="button" className="transfer-jump" disabled={!side || !nextTransfer} onClick={() => side && nextTransfer && onTransfer(side, nextTransfer)}>{nextTransfer && nextTransfer.startUs <= time ? 'Replay transfer' : 'View next transfer'}</button></div>
          <div className="handoff-counts">
            <button type="button" disabled={!inTransit.length} aria-expanded={expanded?.kind === 'transfers'} aria-controls={detailId} onClick={() => reveal({ kind: 'transfers' })}><strong>{inTransit.length}</strong> in transit</button>
            <button type="button" className="kv-wait-count" disabled={!waitingForSpace.length} aria-expanded={expanded?.kind === 'kv-wait'} aria-controls={detailId} onClick={() => reveal({ kind: 'kv-wait' })}><strong>{waitingForSpace.length}</strong> waiting for space</button>
          </div>
          <div className="handoff-preview">
            {featuredTransfer ? <>
              <div className="handoff-route"><span>{instanceLabel(featuredTransfer.prefillInstanceId)}</span><svg width="24" height="14" viewBox="0 0 24 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M1 7h21m-5-5 5 5-5 5" /></svg><span>{instanceLabel(featuredTransfer.decodeInstanceId)}</span><span className="handoff-percent">{Math.floor(progress)}%</span></div>
              <div className="handoff-progress" role="progressbar" aria-label={`KV transfer for ${featuredEvent ? requestLabel(featuredEvent) : featuredTransfer.requestId}`} aria-valuenow={Math.floor(progress)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div>
              <button type="button" className="handoff-request" onClick={() => { if (featuredEvent) onSelect(requestKey(featuredEvent)); }}>{featuredEvent ? requestLabel(featuredEvent) : featuredTransfer.requestId} · {formatMs((featuredTransfer.endUs - featuredTransfer.startUs) / 1000)} <span>Inspect</span></button>
            </> : <p className="handoff-idle">{!side ? 'KV context moves from prefill to decode.' : delivered === transfers.length && transfers.length > 0 ? 'All KV transfers delivered.' : waitingForSpace.length ? 'Waiting for space in the decode pool.' : 'No transfers at this moment.'}</p>}
          </div>
          <div className="handoff-meta"><span>{network}</span><span>{delivered} delivered</span></div>
        </section>
        <section className="flow-pool" aria-label="Decode pool"><div className="flow-heading"><h3>Decode</h3><span>Generate output · {config.instances - config.prefillInstances} GPUs</span></div>{renderInstances(ids.filter(id => role(id) === 'decode'), 'Decode pool')}</section>
      </> : <section className="flow-pool" aria-label="Combined instances"><div className="flow-heading"><h3>Instances</h3><span>Prefill + decode</span></div>{renderInstances(ids, 'Combined instances')}</section>}
    </div>
    <div id={detailId} className="pool-inspection" hidden={!expanded}>
      <div className="pool-inspection-heading"><h3 ref={detailHeading} tabIndex={-1}>{detailTitle}</h3><button type="button" onClick={() => { setExpanded(undefined); detailTrigger.current?.focus(); }} aria-label={`Close ${title} request list`}>Close</button></div>
      {expandedInstance && <p className="instance-cache">KV cache used: {((snapshot?.InstanceSnapshots.find(instance => instance.ID === expandedInstance)?.KVUtilization ?? 0) * 100).toFixed(1)}%</p>}
      <div className="pool-request-list">{detailEvents.map(event => <button type="button" key={event.requestId} aria-pressed={requestKey(event) === selected} onClick={() => onSelect(requestKey(event))}><span>{requestLabel(event)}</span><span>{expanded?.kind === 'transfers' ? 'In transit' : eventLabel(event)}</span></button>)}{!detailEvents.length && <p>No requests here at this moment.</p>}</div>
    </div>
  </article>;
}
