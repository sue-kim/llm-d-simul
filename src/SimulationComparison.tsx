import { useState } from 'react';
import type { Comparison, Config, Event, Side, Transfer } from './types';
import { SimulationCluster } from './SimulationCluster';
import type { PoolSection } from './SimulationCluster';
import { isQueued, isRunning } from './comparisonPlayback';

export function SimulationComparison({ result, config, network, hardware, states, time, selected, instanceScale, onSelect, onPause, onTransfer }: {
  result?: Comparison; config: Config; network: string; hardware: string;
  states: { basic: Map<string, Event>; llmd: Map<string, Event> }; time: number; selected: string; instanceScale: number;
  onSelect: (key: string) => void; onPause: () => void; onTransfer: (side: Side, transfer: Transfer) => void;
}) {
  const [openSections, setOpenSections] = useState<Partial<Record<PoolSection, boolean>>>({});
  const idleSections = { prefill: !!result, decode: !!result, combined: !!result, transfer: !!result };
  for (const policy of ['basic', 'llmd'] as const) {
    const side = result?.[policy];
    const ids = side?.playback.snapshots.at(-1)?.InstanceSnapshots.map(instance => instance.ID)
      ?? Array.from({ length: config.instances }, (_, index) => `instance_${index}`);
    for (const event of states[policy].values()) {
      if (isQueued(event) || isRunning(event)) {
        idleSections.combined = false;
        if (event.instanceId) {
          const pool = side?.playback.pools?.[event.instanceId]
            ?? (ids.indexOf(event.instanceId) < config.prefillInstances ? 'prefill' : 'decode');
          idleSections[pool] = false;
        } else idleSections.prefill = idleSections.decode = false;
      }
      if (event.kind === 'kv_wait') idleSections.prefill = idleSections.decode = idleSections.transfer = false;
    }
    if (side?.playback.transfers?.some(transfer => transfer.startUs <= time && time < transfer.endUs)) {
      idleSections.prefill = idleSections.decode = idleSections.transfer = false;
    }
  }
  function toggleSection(section: PoolSection) {
    onPause();
    setOpenSections(previous => ({ ...previous, [section]: !previous[section] }));
  }
  const shared = { config, network, hardware, time, selected, instanceScale, onSelect, onPause, onTransfer, idleSections, openSections, onToggleSection: toggleSection };
  return <section className="comparison" aria-label="Side-by-side simulation">
    <SimulationCluster {...shared} title="Basic load balancing" description={config.disaggregated ? 'Random selection within each pool' : 'Random endpoint selection'} variant="basic" side={result?.basic} states={states.basic} />
    <SimulationCluster {...shared} title="llm-d routing" description="In-flight load, queue, and cache scoring" variant="llmd" side={result?.llmd} states={states.llmd} />
  </section>;
}
