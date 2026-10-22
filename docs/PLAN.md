# llm-d workload simulator implementation plan

Agreed direction: October 22, 2026.

## Purpose

Help developers answer: **For my workload and hardware, what changes when I use llm-d, and is the improvement worth investigating?**

Developers should be able to run a representative workload before deploying infrastructure, see where requests spend time, and understand when llm-d routing helps, has little effect, or makes performance worse under the selected assumptions.

## Starting experience

Open with an editable chat workload and two synchronized cluster views:

- **Basic load balancing:** a simple routing policy over vLLM replicas.
- **llm-d routing:** an explicit llm-d routing configuration over equivalent replicas.

Users can run immediately or change the model, GPU type, and instance count.

The proposed default is **Llama 3.1 8B with four H100 GPUs, one GPU per instance**. Verify the complete model, hardware, precision, engine, and coefficient combination in the first integration milestone before making it the default. Catalog presence alone is not evidence of prediction accuracy.

Start hardware selection with supported combinations of A100 80GB, H100, and H200. Explain the relationship between instances and GPUs whenever a configuration uses multiple GPUs per instance. Expose compatible combinations rather than accepting arbitrary configurations that cannot be priced.

## Workloads

| Example | Behavior to explore | Editable controls |
|---|---|---|
| Chat | Response speed, bursts, and shared system prompts | Input/output lengths, traffic volume, burstiness, shared context |
| Document summarization | Long inputs, prefill pressure, and growing queues | Input/output lengths, traffic volume, burstiness, shared context |
| Code generation | Long outputs and repeated repository context | Input/output lengths, traffic volume, burstiness, shared context |
| Multi-turn agents | Sequential requests, accumulated context, and cache reuse | Token lengths, session traffic, turns, time between requests, shared context |

Chat and summarization can start from the official BLIS catalog presets. Code generation and agents need documented workload definitions using BLIS-supported distributions and session behavior.

Presets are synthetic examples. Label the source of each preset, preserve its distribution parameters, and identify user edits. Do not describe a preset as a measured production trace.

Use request rate for independent requests and session or user controls for response-dependent workloads. Avoid implying that request rate and concurrency are interchangeable.

Source: [BLIS workload specifications](https://github.com/inference-sim/inference-sim/blob/v0.12.0/docs/guide/workloads.md) and [workload catalog](https://github.com/inference-sim/blis-catalog/tree/main/workloads).

## Comparison methodology

Both sides use the same total hardware allocation, model, precision, engine settings, token demands, and initial cache conditions. Make the changed routing settings visible. Prefix caching remains available on both sides so the comparison measures how routing uses it.

For single-turn workloads, feed identical requests and arrival timestamps to both runs. For multi-turn agents, match session definitions, token demands, think times, and random draws; subsequent arrivals depend on each side's preceding response completion. Match requests by session and turn even when their arrival times diverge.

Pin the simulator, catalog, coefficient registry, kernel dependencies, and resolved configurations for reproducibility. Use a common measurement window and warmup policy. Report unfinished, rejected, dropped, and timed-out requests alongside latency statistics so completing fewer requests cannot masquerade as a performance improvement.

### Baseline representation

BLIS v0.12.0 routes every cluster simulation through the embedded llm-d router. Implement the baseline as basic random endpoint selection within this framework, with advanced routing features disabled. Implement the llm-d side with an explicit supported configuration. Validate the baseline configuration in the first milestone.

Describe the result as a simulated policy comparison. The baseline is not a measurement of a separately deployed proxy or an arbitrary existing production stack.

BLIS models router decision time as zero. Keep gateway and router overhead assumptions visible when explaining latency estimates. Do not claim that this comparison captures the operational cost of adopting llm-d.

Source: [BLIS v0.12.0 routing documentation](https://github.com/inference-sim/inference-sim/blob/v0.12.0/docs/guide/routing.md).

## Simulation view and inspection

Show the path from arriving requests through routing, queues, and processing instances. Instance cards display hardware, queued and running requests, active batches, and KV-cache occupancy.

A shared playback bar provides play, pause, speed adjustment, step, and timeline scrubbing. Both sides always use the same playback clock. Simulated time is distinct from playback speed and the time required to compute a run.

Selecting a request highlights its counterpart and opens an inspector with:

- Request identity, workload, input/output size, and session/turn when applicable.
- Selected instance and recorded routing scores or decision reason.
- Time spent waiting and processing, first-token time, and completion status.
- The selected request's state on both sides at the current simulated time.

Generate explanations from recorded evidence. Routing preferences and candidate scores are not proof of the latency a request would have achieved on an unchosen instance.

At high request volumes, aggregate visual markers while preserving exact counts and inspectable request records. Do not imply that an aggregate marker represents one request.

## Metrics and interpretation

Keep a compact comparison visible during playback and a fuller result summary after the run.

| Metric | Purpose |
|---|---|
| Time to first token, median and p95 | Compare initial responsiveness |
| End-to-end response time, median and p95 | Compare total request duration |
| Completed requests and output tokens per second | Compare throughput over a common window |
| Queue length and waiting time | Expose saturation and backlog |
| Unfinished, failed, rejected, dropped, and timed-out requests | Show outcomes omitted by completed-request latency statistics |
| Cache hit rate and KV-cache occupancy | Explain reuse and memory pressure |
| Percentage meeting an editable response-time target | Relate outcomes to the developer's requirement |
| Simulated instance busy time, when available | Show modeled activity without claiming measured GPU utilization |

Define each metric's units, sample population, and time window. Use BLIS's measured-window results consistently rather than mixing stdout and result-file aggregates with different semantics. Preserve underlying request counts and make small samples visible when reporting percentiles.

The result summary should explain observed differences, identify where queues formed, and state whether the user's target was met. It should permit improvement, little difference, and regression without a predetermined recommendation to adopt llm-d.

Source: [BLIS metrics and results](https://github.com/inference-sim/inference-sim/blob/v0.12.0/docs/guide/results.md).

## Architecture

Use a React and TypeScript interface with a small Go simulation service. The service executes pinned BLIS configurations and produces a normalized playback dataset for the browser.

The data flow is:

1. Validate the user's workload and supported deployment configuration.
2. Resolve the common workload inputs and the two routing configurations.
3. Run both simulations with recorded seeds and versions.
4. Collect metrics, routing decisions, instance snapshots, and request lifecycle events.
5. Normalize the results into a shared timeline with stable request identities.
6. Play, pause, and inspect the recorded results independently of simulation execution.

Cache completed comparisons by the full resolved configuration and version set. Changing a setting creates a new run; playback controls only navigate an existing result.

### Trace integration

BLIS exposes per-request results, routing decision records, and progress snapshots. Existing decision traces do not contain every lifecycle transition needed for exact request inspection and scrubbing.

The first milestone must determine the smallest read-only instrumentation needed to capture queue entry/exit, processing stages, preemption, first token, and terminal outcomes. Preserve event ordering and simulator behavior. Do not infer an exact lifecycle from aggregate timings when the required events are absent.

Use existing snapshots for queue, batch, and KV-cache state where appropriate. Some snapshot counters update at request completion, so they cannot automatically serve as a continuous generated-token counter. Prefill/decode snapshots also require parent-request accounting to avoid counting prefill and decode completions twice.

Sources: [decision trace schema](https://github.com/inference-sim/inference-sim/blob/v0.12.0/sim/trace/record.go) and [progress snapshot interface](https://github.com/inference-sim/inference-sim/blob/v0.12.0/sim/progress_hook.go).

### Data provenance

Use official BLIS sources:

- [inference-sim](https://github.com/inference-sim/inference-sim) for execution and routing integration.
- [blis-catalog](https://github.com/inference-sim/blis-catalog) for model, hardware, fabric, and preset definitions.
- [blis-registry](https://github.com/inference-sim/blis-registry) for fitted or assumed coefficients and their provenance.
- [blis-latency-kernel](https://github.com/inference-sim/blis-latency-kernel) for timing and memory estimates.

Retain the provenance reported by the kernel. Identify measured, vendor-specified, assumed, or fallback inputs without converting coefficient coverage into an invented accuracy percentage.

## Delivery milestones

| Milestone | Deliverable | Completion condition |
|---|---|---|
| 1. BLIS integration | One reproducible comparison, a supported default, and a playback event format | Both configurations run; request identities, outcomes, timings, and required lifecycle events are available |
| 2. Interactive comparison | Two cluster views with synchronized playback, queues, instance details, and request inspection | A request can be followed and compared across both sides while paused or scrubbing |
| 3. Workload exploration | Four editable presets, supported model/GPU selection, and results summary | Edits produce new BLIS runs with visible assumptions and internally consistent metrics |
| 4. Prefill/decode exploration | Optional separate prefill and decode pools with visible KV transfers | Comparison preserves total hardware allocation and includes transfer costs and correct parent-request accounting |

The first implementation milestone proves one trustworthy end-to-end comparison before expanding the interface.

## Critical checks

Focus validation on behavior that could mislead an adoption decision:

- Equal comparison inputs and hardware allocation, with intentional policy differences recorded.
- Deterministic results for pinned versions, configurations, and seeds.
- Request conservation across completed, waiting, running, and terminal failure states.
- Valid event ordering and consistent request identities, including session turns.
- Agreement between displayed metrics and BLIS results, including units and measurement windows.
- Identical recorded state when reaching a timestamp by playback or scrubbing.
- Instrumentation that does not change routing, scheduling, or numerical results.
- Correct error handling for unsupported configurations or failed simulations.

Use targeted integration checks and a browser walkthrough for the core experience. Routine documentation and low-impact visual edits do not require repeated full validation.

## Deferred scope

Production trace uploads, live deployment connections, automatic infrastructure provisioning, monetary ROI estimates, and autoscaling experiments are outside the initial implementation. Start with synthetic editable workloads and fixed hardware allocations to establish the core comparison.

## Technical decisions to resolve in milestone one

- Verify the proposed Llama 3.1 8B and H100 default and select compatible dependency pins.
- Verify the simple-routing baseline and choose the explicit llm-d routing configuration.
- Confirm complete request lifecycle coverage and the minimum instrumentation required.
- Choose run duration, warmup, request limits, and workload control ranges based on observed simulator runtime and output size.
- Establish which model/GPU combinations have sufficient evidence to expose, and how their remaining assumptions appear in the interface.
