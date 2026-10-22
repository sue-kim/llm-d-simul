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

## Compare workloads

Choose Llama 3.1 8B Instruct, Qwen 2.5 7B Instruct, or Qwen3 14B on NVIDIA A100 80GB, H100, or H200. All nine combinations use BF16 and 2–8 replicas, one GPU per replica. The model, GPU, instance count, and engine settings always match across the two policies. The default remains Llama 3.1 8B on four H100s.

Choose chat, summarization, code generation, or multi-turn agents. Code generation defaults to 64 requests with a mean 2,048-token output and shared repository context. Agent sessions default to 16 agents with four sequential turns each, a 500 ms pause, and growing context. Edit token lengths and either request traffic or session count, turns, pauses, and start delay. Run both policies, pause or scrub their synchronized timelines, and inspect a request's lifecycle and routing scores. Changing a selection leaves the previous result labeled with its original deployment until a new comparison finishes.

Basic routing uses random endpoint selection. The llm-d side uses the upstream in-flight load configuration for combined instances and the upstream prefix-cache/queue configuration for separate pools. Both run inside BLIS's embedded llm-d router with the same model, hardware, engine settings, and cold caches. All displayed performance values come from these simulations.

The service verifies actual input/output token hashes on both sides. Single-turn workloads also require identical arrival times. Agents share the same session starts and per-turn token content; each follow-up arrives after its own previous BLIS completion plus the pause, so later arrival times can differ. The inspector matches agent and turn across both sides and breaks down retained context versus new input. Its result export contains raw BLIS metrics, decision records, playback events, snapshots, dependency pins, and modeling assumptions. Raw runs and resolved YAML are retained under `.runtime/runs/<run-id>/`.

Choose **Separate prefill / decode pools** under Infrastructure to split the total GPU budget between input processing and output generation. Both policies receive the same split, model, GPU, and network. Choose InfiniBand 400 Gb/s, RoCE 200 Gb/s, or Ethernet 100 Gb/s from the pinned catalog. Each GPU occupies its own node, and simultaneous transfers contend for bandwidth. This mode compares routing within a shared disaggregated layout; it does not compare a combined baseline against a disaggregated llm-d deployment.

Playback shows separate pools and KV transfers between them. Use **Inspect next transfer** to pause inside a recorded transfer. The request inspector shows both endpoint assignments, prefill/decode queue waits, waiting for decode KV capacity, transfer duration, and blocks actually pulled after cache reuse. Each original request is counted once. Network rates are nominal catalog specifications, not measured deployment bandwidth.

Under **Full run results**, set first-token and full-response time limits plus the percentage of requests that must meet both. The example targets are 1 second, 10 seconds, and 95%. Changes reassess the existing run instantly without running BLIS again. Each request must finish and satisfy both inclusive limits. Failed, unfinished, unmeasured, and un-emitted planned agent turns count as misses; agent targets apply per model call.

The results summary states whether either policy meets the requirement, shows exact counts, and explains mean timing differences using requests completed on both sides. Expand **Timing breakdown** for preparation/admission, engine or per-pool queues, KV-space waiting, standalone transfer cost, contention, first-token work, and the rest of the response. Queue findings identify the instance with the most accumulated wait. **Inspect largest request gap** pauses the shared timeline at supporting evidence. Exported JSON includes the current targets and versioned assessment alongside the original BLIS result.

See [BLIS integration details](docs/BLIS_INTEGRATION.md) for the instrumentation, units, and current limits, and the [implementation plan](docs/PLAN.md) for delivery scope.

## Critical checks

```sh
npm test
npm run build
npm run test:analysis
# With the API running:
npm run test:integration
npm run test:deployments
npm run test:workloads
npm run test:disaggregation
```

Analysis checks cover inclusive and joint targets, failure and missing-data denominators, exact percentage boundaries, session matching, preemption, and non-overlapping phase totals.

Integration checks run real BLIS comparisons, account for requests, compare first-token timestamps to BLIS metrics, verify determinism, and compare instrumented and uninstrumented execution. They also exercise summarization and reject unsupported hardware. Workload checks exercise the full code and agent defaults, prove causal turn timing and retained token identity, verify that observation leaves session execution unchanged, and reject possible context overflow.

Disaggregation checks cover all four workloads, matched and uneven GPU splits, actual transfer records and parent accounting, zero-pause agent sessions, three model/GPU/network combinations, network bandwidth effects, and inert deterministic observation.

Deployment checks exercise all nine model/GPU combinations on both policies, verify matching resolved YAML and request inputs, and check that model and hardware changes affect simulated timing and cache identity. The selector metadata is generated from the pinned catalog with `npm run catalog:sync`; it is a curated support list, not the catalog's entire inventory.

## Agreed scope

- Side-by-side comparisons using the same model and hardware allocation.
- Editable chat, document summarization, code generation, and multi-turn agent workloads.
- A default model, GPU, and instance count that users can change.
- Synchronized playback with pause, step, scrubbing, and request inspection.
- Queue, latency, throughput, cache, and request outcome comparisons.
- Optional prefill/decode pools with matched total GPU budgets and visible KV transfers.

## Primary sources

- [llm-d architecture](https://llm-d.ai/docs/architecture)
- [BLIS simulator](https://github.com/inference-sim/inference-sim)
- [BLIS catalog](https://github.com/inference-sim/blis-catalog)
- [BLIS coefficient registry](https://github.com/inference-sim/blis-registry)
