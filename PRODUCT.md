# llm-d simulator

## Purpose

Developers considering llm-d compare their workload under basic and llm-d routing before deploying infrastructure. They edit workload parameters, use an equal hardware allocation, and inspect queues and individual requests to understand the result.

## Platform

Web application, initially served locally. React and TypeScript frontend; Go API executing pinned BLIS runs on CPU.

## Current scope

The first slice supports a reproducible side-by-side comparison on Llama 3.1 8B and H100 replicas, synchronized playback, request inspection, and exported results. The agreed wider scope is in `docs/PLAN.md`.

## Product truth

All performance numbers come from BLIS execution. Synthetic workload assumptions and coefficient provenance remain visible. The comparison can favor either policy. The interface distinguishes simulated time, full-run metrics, request lifecycle events, and sampled instance gauges.
