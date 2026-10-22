export type Config = {
  workload: 'chat' | 'summarization' | 'code' | 'agents'; model: string; hardware: string;
  instances: number; requests: number; rate: number; inputTokens: number;
  outputTokens: number; prefixTokens: number; seed: number;
  sessions: number; turns: number; thinkTimeMs: number; meanStartMs: number;
  disaggregated: boolean; prefillInstances: number; fabric: string;
};
export type ModelOption = { id: string; label: string; nativeContextTokens: number; hardwareIds: string[] };
export type HardwareOption = { id: string; label: string; shortLabel: string; memoryGiB: number };
export type DeploymentOptions = { catalogCommit: string; precision: string; contextLimit: number; gpusPerInstance: number; models: ModelOption[]; hardware: HardwareOption[]; networks: {id: string; label: string; bandwidthGBps: number}[] };
export type Deployment = { model: ModelOption; hardware: HardwareOption; precision: string; contextLimit: number; gpusPerInstance: number };
export type Stage = 'arrived' | 'routed' | 'queued' | 'processing' | 'streaming' | 'completed' | 'preempted' | 'timed_out' | 'prefilling' | 'kv_wait' | 'transferring' | 'kv_transferred' | 'decoding' | 'dropped';
export type Event = { timeUs: number; requestId: string; kind: Stage; instanceId?: string; phase?: 'prefill' | 'decode' | 'transfer'; subRequestId?: string; inputTokens: number; outputTokens: number; sessionId?: string; clientId?: string; roundIndex: number; historyTokens?: number; retainedOutputTokens?: number; inputHash?: string; outputHash?: string; contextHash?: string; historyHash?: string };
export type Transfer = {requestId: string; prefillInstanceId: string; decodeInstanceId: string; prefillSubRequestId: string; decodeSubRequestId: string; prefillCompleteUs: number; startUs: number; endUs: number; aloneUs: number; blocks: number; pulledBlocks: number};
export type InstanceSnapshot = { ID: string; QueueDepth: number; BatchSize: number; KVUtilization: number; CacheHitRate: number; CompletedRequests: number; PreemptionCount: number };
export type Snapshot = { Clock: number; InstanceSnapshots: InstanceSnapshot[]; TotalCompleted: number; IsFinal: boolean };
export type Routing = { RequestID: string; Clock: number; ChosenInstance: string; Reason: string; Scores: Record<string, number> | null; Candidates: { InstanceID: string; Score: number; QueueDepth: number; InFlightRequests: number; KVUtilization: number }[] | null };
export type RequestMetric = { requestID: string; arrived_at: number; handled_by: string; ttft_ms: number; e2e_ms: number; scheduling_delay_ms: number; num_prefill_tokens: number; num_decode_tokens: number };
export type Metrics = {
  completed_requests: number; injected_requests: number; still_queued: number; still_running: number;
  ttft_p50_ms: number; ttft_p95_ms: number; e2e_p50_ms: number; e2e_p95_ms: number;
  total_output_tokens: number; cache_hit_rate: number; timed_out_requests?: number;
  dropped_unservable?: number; failed_requests?: number; requests: RequestMetric[];
  kernel_provenance?: Record<string, { method_counts: Record<string, number>; assumptions: unknown[] }>;
  pd?: {transfers: number; transfer_time_p50_ms: number; transfer_time_p90_ms: number; transfer_queue_delay_mean_ms: number; transfer_queue_delay_p90_ms: number};
};
export type Side = { policy: string; metrics: Metrics; playback: { events: Event[]; snapshots: Snapshot[]; pools?: Record<string, 'prefill' | 'decode'>; transfers?: Transfer[]; rawEvents?: Event[]; decisions: { Routings: Routing[]; PrefillRoutings?: {ParentRequestID: string; ChosenInstance: string}[] } }; log: string };
export type Comparison = { id: string; config: Config; deployment: Deployment; basic: Side; llmd: Side; endTimeUs: number; identicalInputs: boolean; fairness: {mode: 'identical-arrivals' | 'matched-sessions'; matchedRequests: number; identicalArrivalTimes: boolean}; provenance: { go: string; repositories: Record<string, { tag: string; commit: string }> }; adapterVersion: string; assumptions: string[] };
