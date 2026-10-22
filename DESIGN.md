# Comparison interface

The comparison is a task interface for developers. Configuration stays on the left, two policy views share a horizontal scale, and a common timeline controls both. Full-run metrics and the request inspector sit below the playback view.

## Visual decisions

- Warm neutral workspace `#f5f5f1`, white working surfaces, graphite text `#222c30`.
- Basic routing uses slate blue `#6379a8`; llm-d uses green `#177866`; queued requests use amber `#d8ad66`.
- IBM Plex Sans at 400, 500, and 600, self-hosted from the installed font package. Numeric data uses tabular figures.
- Fine rules, restrained radii, dense legible controls, and color used to identify policy or state.
- On narrow screens the configuration precedes vertically stacked policy views. Metrics remain a scrollable comparison table.
- Model and GPU selectors share the workload fields' appearance. The chosen allocation is repeated below the controls; the comparison header and both policy cards use the completed run's recorded deployment.
- Keyboard controls, visible focus, text labels alongside state colors, and reduced-motion support.

## Motion and data

Request markers represent recorded requests. Playback changes the observation time, never simulation results. Full-run metrics do not animate or imply live accumulation. Large request populations show an explicit overflow count.

## Agent workloads

Four workload presets share the same controls. Agent selection replaces request-rate controls with session count, turns, pause, and start delay. The comparison explains why later arrivals can differ. The inspector pairs agent/turn identities, provides turn navigation, and separates retained context, new input, and output tokens. Full-run session duration includes pauses; the two policy clocks stay synchronized.
