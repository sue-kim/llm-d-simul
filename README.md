# llm-d workload simulator

An interactive simulator for developers evaluating whether llm-d would help their workloads before deploying it. Compare basic load balancing and llm-d routing side by side, edit workloads and hardware, and pause to inspect requests, queues, and instance activity.

Performance estimates come from BLIS, with the simulator version, workload assumptions, and data provenance attached to each run.

## Run locally

Requires Node.js 22.12 or newer, npm, Python 3.9 or newer, and Git. Setup supports macOS and Linux on arm64 or amd64. No GPU or model-weight download is required.

```sh
npm ci
npm run setup
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The simulation API runs on port 8787. The first setup downloads pinned BLIS sources, its catalog and registry, a project-local Go compiler, and Go dependencies into the ignored `.runtime/` directory. Subsequent simulation runs work locally.

For a production build served by the same local API:

```sh
npm run build
npm start
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

## First working comparison

Choose Llama 3.1 8B Instruct, Qwen 2.5 7B Instruct, or Qwen3 14B on NVIDIA A100 80GB, H100, or H200. All nine combinations use BF16 and 2–8 replicas, one GPU per replica. The model, GPU, instance count, and engine settings always match across the two policies. The default remains Llama 3.1 8B on four H100s.

Choose chat or summarization and edit token lengths, shared context, request count, traffic, and seed. Run both policies, pause or scrub their synchronized timelines, and inspect a request's lifecycle and routing scores. Changing a selection leaves the previous result labeled with its original deployment until a new comparison finishes.

Basic routing uses random endpoint selection. The llm-d side uses the upstream in-flight load configuration. Both run inside BLIS's embedded llm-d router with the same model, hardware, engine settings, and cold caches. All displayed performance values come from these simulations.

The service verifies that request IDs, arrival times, and token demands match before returning a comparison. Its result export contains raw BLIS metrics, decision records, playback events, snapshots, dependency pins, and modeling assumptions. Raw runs and resolved YAML are retained under `.runtime/runs/<run-id>/`.

See [BLIS integration details](docs/BLIS_INTEGRATION.md) for the instrumentation, units, and current limits, and the [implementation plan](docs/PLAN.md) for the remaining milestones.

## Critical checks

```sh
npm test
npm run build
# With the API running:
npm run test:integration
npm run test:deployments
```

Integration checks run real BLIS comparisons, account for requests, compare first-token timestamps to BLIS metrics, verify determinism, and compare instrumented and uninstrumented execution. They also exercise summarization and reject unsupported hardware.

Deployment checks exercise all nine model/GPU combinations on both policies, verify matching resolved YAML and request inputs, and check that model and hardware changes affect simulated timing and cache identity. The selector metadata is generated from the pinned catalog with `npm run catalog:sync`; it is a curated support list, not the catalog's entire inventory.

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
