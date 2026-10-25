# Comparison interface

The comparison is a task interface for developers. Configuration stays on the left, two policy views share a horizontal scale, and a common timeline controls both. Full-run metrics and the request inspector sit below the playback view.

## Visual decisions

- Silver workspace `#e7e8e6`, white working surfaces, and charcoal text `#242729`, drawn from the supplied silver-can color reference.
- Vermilion `#bd3524` identifies the primary action, active selection, and llm-d routing. Basic routing uses charcoal `#535e63`; queued requests use amber `#b18440`.
- IBM Plex Sans at 400, 500, and 600, self-hosted from the installed font package. Numeric data uses tabular figures.
- Fine rules, restrained radii, dense legible controls, and color used to identify policy or state.
- On narrow screens the configuration precedes vertically stacked policy views. Metrics remain a scrollable comparison table.
- Model and GPU selectors share the workload fields' appearance. The chosen allocation is repeated below the controls; the comparison header and both policy cards use the completed run's recorded deployment.
- Keyboard controls, visible focus, text labels alongside state colors, and reduced-motion support.

## Color tokens

`src/tokens.css` owns the palette. Use `--color-canvas`, `--color-surface`, and the sidebar/subtle/hover/active surface roles for the silver layers. Use the text and border roles for neutral content, and `--color-accent` with its hover, strong, and soft variants for actions and selection. Closed selectors use white surfaces; selected options use the soft accent.

Policy aliases `--basic` and `--llmd` identify the two strategies throughout cards, request markers, and meters. Success, warning, information, and error colors have separate semantic tokens: vermilion identifies llm-d without implying a failed run. Status labels, numbers, and spatial grouping supplement every data color. The reference informs color only; the compact layout and IBM Plex typography remain.

## Typography tokens

`src/tokens.css` defines the shared font family, weights, semantic sizes, and line heights. Base text, general headings, and the settings panel consume these tokens in `src/styles.css`. Choose a token by the text's role when adding or adjusting controls.

| Settings role | Size at the default browser setting | Weight | Token |
| --- | --- | --- | --- |
| Panel heading | 13px | 600 | `--text-panel-title` |
| Field label / disclosure | 12px | 500 | `--text-label` |
| Input / selector / action | 13px | 400 for inputs, 500 for selectors and actions | `--text-control` |
| Helper text | 11px | 400 | `--text-help` |
| Footer note | 10px | 400 | `--text-caption` |

Panel headings use `--leading-title` (1.3), controls and labels use `--leading-control` (1.25), and supporting copy uses `--leading-body` (1.5). Keep sentence case and normal tracking. Size tokens use rem with a 100% root; body text uses `--text-body` (14px by default). On small screens, numeric inputs use `--text-touch-input` (16px by default). Existing control dimensions and focus targets remain independent of the type scale.

## Motion and data

Request markers represent recorded requests. Playback changes the observation time, never simulation results. Full-run metrics do not animate or imply live accumulation. Large request populations show an explicit overflow count.

## Agent workloads

Four workload presets share the same controls. Agent selection replaces request-rate controls with session count, turns, pause, and start delay. The comparison explains why later arrivals can differ. The inspector pairs agent/turn identities, provides turn navigation, and separates retained context, new input, and output tokens. Full-run session duration includes pauses; the two policy clocks stay synchronized.

## Separate prefill/decode pools

Keep one total GPU budget, split, and network control shared by both strategies. Group instance cards by prefill and decode with an intervening KV-transfer lane. Show in-transit and delivered counts, actual transfer progress, and a direct action to pause inside a transfer. Keep the sum of both pools visible on each side. Queue and finished counts describe parent requests; inspect both assignments, per-pool waits, capacity wait, and blocks pulled without exposing child IDs as extra user requests. Raw child records remain available in the export.

## Latency targets and results summary

Place shared target controls beside full-run results: first-token limit, response limit, and required percentage. Target edits reassess the current result immediately, independently of simulation settings and playback. Show one target verdict and matched policy cards with pass counts, percentage bars, a required-percentage marker, and failed/unfinished outcomes. Preserve either-policy wins and regressions. Explain the largest observed mean differences with links to request evidence; use an expandable phase table and per-instance queue findings for detail. Keep the sample population explicit and include active targets in exports.
