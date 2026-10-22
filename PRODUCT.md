# llm-d simulator

## Purpose

Developers considering llm-d compare their workload under basic and llm-d routing before deploying infrastructure. They edit workload parameters, use an equal hardware allocation, and inspect queues and individual requests to understand the result.

## Platform

Web application, initially served locally. React and TypeScript frontend; Go API executing pinned BLIS runs on CPU.

## Current scope

Editable chat, summarization, code generation, and multi-turn agent sessions are supported. Agents reuse their own context and wait for each response before the next turn. The inspector pairs sessions and turns across policies, and results include total session latency. The simulator supports Llama 3.1 8B Instruct, Qwen 2.5 7B Instruct, and Qwen3 14B on A100 80GB, H100, and H200 replicas, synchronized playback, request inspection, and exported results. A shared selection always applies to both policies. Previous results retain their original deployment until another run completes. The agreed wider scope is in `docs/PLAN.md`.

## Product truth

All performance numbers come from BLIS execution. Synthetic workload assumptions and coefficient provenance remain visible. The comparison can favor either policy. The interface distinguishes simulated time, full-run metrics, request lifecycle events, and sampled instance gauges.
