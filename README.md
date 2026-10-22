# llm-d workload simulator

An interactive simulator for developers evaluating whether llm-d would help their workloads before deploying it. Compare basic load balancing and llm-d routing side by side, edit workloads and hardware, and pause to inspect requests, queues, and instance activity.

Performance estimates will come from BLIS, with the simulator version, workload assumptions, and data provenance attached to each run.

## Project status

Planning is complete. Application implementation has not started.

The [implementation plan](docs/PLAN.md) records the agreed experience, comparison methodology, BLIS integration, delivery milestones, and critical checks.

## Agreed scope

- Side-by-side comparisons using the same model and hardware allocation.
- Editable chat, document summarization, code generation, and multi-turn agent workloads.
- A default model, GPU, and instance count that users can change.
- Synchronized playback with pause, step, scrubbing, and request inspection.
- Queue, latency, throughput, cache, and request outcome comparisons.
- Optional prefill/decode disaggregation after the initial routing comparison works.

## Primary sources

- [llm-d architecture](https://llm-d.ai/docs/architecture)
- [BLIS simulator](https://github.com/inference-sim/inference-sim)
- [BLIS catalog](https://github.com/inference-sim/blis-catalog)
- [BLIS coefficient registry](https://github.com/inference-sim/blis-registry)
