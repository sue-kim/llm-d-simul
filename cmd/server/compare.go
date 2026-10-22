package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const adapterVersion = "3"

type Config struct {
	Disaggregated    bool    `json:"disaggregated"`
	PrefillInstances int     `json:"prefillInstances"`
	Fabric           string  `json:"fabric"`
	Workload         string  `json:"workload"`
	Model            string  `json:"model"`
	Hardware         string  `json:"hardware"`
	Instances        int     `json:"instances"`
	Requests         int     `json:"requests"`
	Rate             float64 `json:"rate"`
	InputTokens      int     `json:"inputTokens"`
	OutputTokens     int     `json:"outputTokens"`
	PrefixTokens     int     `json:"prefixTokens"`
	Seed             int     `json:"seed"`
	Sessions         int     `json:"sessions"`
	Turns            int     `json:"turns"`
	ThinkTimeMs      int     `json:"thinkTimeMs"`
	MeanStartMs      int     `json:"meanStartMs"`
}

func defaultConfig() Config {
	return Config{Workload: "chat", Model: "llama-3.1-8b-instruct", Hardware: "h100", Instances: 4, Requests: 256, Rate: 40, InputTokens: 256, OutputTokens: 256, PrefixTokens: 512, Seed: 42, Sessions: 16, Turns: 4, ThinkTimeMs: 500, MeanStartMs: 1000, PrefillInstances: 2, Fabric: "ib-400g"}
}

func (c Config) Validate() error {
	if err := c.validatePools(); err != nil {
		return err
	}
	if c.Workload != "chat" && c.Workload != "summarization" && c.Workload != "code" && c.Workload != "agents" {
		return fmt.Errorf("Choose chat, summarization, code generation, or multi-turn agents.")
	}
	if _, err := resolveDeployment(c.Model, c.Hardware); err != nil {
		return err
	}
	for _, b := range []struct {
		name            string
		value, min, max int
	}{
		{"Instances", c.Instances, 2, 8}, {"Requests", c.Requests, 16, 1024},
		{"Input tokens", c.InputTokens, 16, 8192}, {"Output tokens", c.OutputTokens, 16, 2048},
		{"Shared prefix tokens", c.PrefixTokens, 0, 4096}, {"Seed", c.Seed, 0, 1000000},
	} {
		if b.value < b.min || b.value > b.max {
			return fmt.Errorf("%s must be between %d and %d.", b.name, b.min, b.max)
		}
	}
	if math.IsNaN(c.Rate) || math.IsInf(c.Rate, 0) || c.Rate < 1 || c.Rate > 300 {
		return fmt.Errorf("Traffic must be between 1 and 300 requests per second.")
	}
	if c.Workload == "agents" {
		for _, b := range []struct {
			name            string
			value, min, max int
		}{
			{"Agent sessions", c.Sessions, 1, 64}, {"Turns per session", c.Turns, 2, 8},
			{"Pause between turns", c.ThinkTimeMs, 0, 5000}, {"Mean start delay", c.MeanStartMs, 10, 30000},
		} {
			if b.value < b.min || b.value > b.max {
				return fmt.Errorf("%s must be between %d and %d.", b.name, b.min, b.max)
			}
		}
		if c.PrefixTokens+2*c.Turns*(c.InputTokens+c.OutputTokens) > deploymentOptions.ContextLimit {
			return fmt.Errorf("Accumulated context can exceed the %d-token engine limit. Reduce turns, new input, output, or initial context.", deploymentOptions.ContextLimit)
		}
	}
	return nil
}

type Event struct {
	Phase                string `json:"phase,omitempty"`
	SubRequestID         string `json:"subRequestId,omitempty"`
	TimeUs               int64  `json:"timeUs"`
	RequestID            string `json:"requestId"`
	Kind                 string `json:"kind"`
	InstanceID           string `json:"instanceId,omitempty"`
	InputTokens          int    `json:"inputTokens"`
	OutputTokens         int    `json:"outputTokens"`
	SessionID            string `json:"sessionId,omitempty"`
	ClientID             string `json:"clientId,omitempty"`
	RoundIndex           int    `json:"roundIndex"`
	InputHash            string `json:"inputHash,omitempty"`
	OutputHash           string `json:"outputHash,omitempty"`
	ContextHash          string `json:"contextHash,omitempty"`
	HistoryHash          string `json:"historyHash,omitempty"`
	HistoryTokens        int    `json:"historyTokens,omitempty"`
	RetainedOutputTokens int    `json:"retainedOutputTokens,omitempty"`
}
type Playback struct {
	RawEvents []Event           `json:"rawEvents,omitempty"`
	Pools     map[string]string `json:"pools"`
	Transfers []Transfer        `json:"transfers"`
	Events    []Event           `json:"events"`
	Snapshots []json.RawMessage `json:"snapshots"`
	Decisions json.RawMessage   `json:"decisions"`
}
type Side struct {
	Policy   string         `json:"policy"`
	Metrics  map[string]any `json:"metrics"`
	Playback Playback       `json:"playback"`
	Log      string         `json:"log"`
}
type Comparison struct {
	ID              string          `json:"id"`
	Config          Config          `json:"config"`
	Deployment      Deployment      `json:"deployment"`
	Basic           Side            `json:"basic"`
	LLMD            Side            `json:"llmd"`
	EndTimeUs       int64           `json:"endTimeUs"`
	IdenticalInputs bool            `json:"identicalInputs"`
	Fairness        Fairness        `json:"fairness"`
	Provenance      json.RawMessage `json:"provenance"`
	AdapterVersion  string          `json:"adapterVersion"`
	Assumptions     []string        `json:"assumptions"`
}

func compare(ctx context.Context, root string, config Config) (*Comparison, error) {
	deployment, err := resolveDeployment(config.Model, config.Hardware)
	if err != nil {
		return nil, err
	}
	lock, err := os.ReadFile(filepath.Join(root, "blis.lock.json"))
	if err != nil {
		return nil, err
	}
	hash := sha256.New()
	configJSON, _ := json.Marshal(config)
	hash.Write(configJSON)
	hash.Write(lock)
	hash.Write(deploymentData)
	hash.Write([]byte(adapterVersion))
	for _, name := range []string{"configs/basic-router.yaml", "configs/llmd-router.yaml", "configs/basic-pd-router.yaml", "configs/llmd-pd-router.yaml", "cmd/server/disaggregation.go", "integrations/blis/playback_pd.go", "cmd/server/compare.go", "cmd/server/workloads.go", "integrations/blis/playback_cmd.go", "integrations/blis/playback_sim.go", "scripts/build-blis.py"} {
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			return nil, err
		}
		hash.Write(data)
	}
	id := hex.EncodeToString(hash.Sum(nil))[:20]
	dir := filepath.Join(root, ".runtime/runs", id)
	if data, err := os.ReadFile(filepath.Join(dir, "comparison.json")); err == nil {
		var saved Comparison
		if json.Unmarshal(data, &saved) == nil {
			return &saved, nil
		}
	}
	if _, err := os.Stat(filepath.Join(root, ".runtime/bin/blis")); err != nil {
		return nil, fmt.Errorf("BLIS is not installed. Run npm run setup, then restart the application.")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	result := &Comparison{ID: id, Config: config, Deployment: deployment, Provenance: lock, AdapterVersion: adapterVersion,
		Assumptions: []string{
			"Synthetic workload; input length excludes the separately specified shared prefix.",
			"Both policies run inside BLIS's embedded llm-d router. Basic routing uses random endpoint selection.",
			fmt.Sprintf("%s model and KV cache; one %s per replica; cold caches; prefix caching enabled on both sides.", deployment.Precision, deployment.Hardware.ShortLabel),
			"Router decision time and gateway latency are zero. Estimates include assumed kernel coefficients.",
			"Playback events are recorded; instance gauges are sampled about every 50 ms of simulated time.",
			"Completed-request latency percentiles come from BLIS. Throughput uses the same full comparison duration for both sides.",
		}}
	result.Basic, err = runSide(ctx, root, dir, "basic", config)
	if err != nil {
		return nil, err
	}
	result.LLMD, err = runSide(ctx, root, dir, "llmd", config)
	if err != nil {
		return nil, err
	}
	result.Fairness, err = verifyWorkload(config, result.Basic.Playback.Events, result.LLMD.Playback.Events)
	if err != nil {
		return nil, err
	}
	result.IdenticalInputs = result.Fairness.IdenticalArrivalTimes
	if config.Disaggregated {
		result.Assumptions = append(result.Assumptions, fmt.Sprintf("Both sides use %d prefill GPUs and %d decode GPUs (%d total), one GPU per node, %s, NixlConnector, and link contention enabled. Fabric bandwidth is nominal catalog data, not a measured deployment rate.", config.PrefillInstances, config.Instances-config.PrefillInstances, config.Instances, config.Fabric))
		result.Assumptions = append(result.Assumptions, "Prefill and decode child events are joined under their original request. Streaming uses BLIS's parent TTFT; completion uses the parent response completion. Agent follow-ups include BLIS's parent completion overhead.")
	}
	if config.Workload == "agents" {
		result.Assumptions[0] = "Synthetic agent sessions: independent initial contexts, with prior input and output context accumulated within each session. The pinned BLIS session manager retains one fewer output token per turn than its generated-token metric. No real tool execution or output quality is modeled."
		result.Assumptions = append(result.Assumptions, "Both sides have identical session starts and token content. Each next turn arrives after its own BLIS completion (engine completion when colocated, parent response completion when disaggregated) plus the configured pause; later arrival times can differ. Session and turn identify matching requests because BLIS follow-up IDs depend on completion order.")
	}
	for _, side := range []Side{result.Basic, result.LLMD} {
		for _, e := range side.Playback.Events {
			if e.TimeUs > result.EndTimeUs {
				result.EndTimeUs = e.TimeUs
			}
		}
		// Include client-visible response overhead in the common measurement window.
		if requests, ok := side.Metrics["requests"].([]any); ok {
			for _, item := range requests {
				r, ok := item.(map[string]any)
				if !ok {
					continue
				}
				end := int64(number(r["arrived_at"])*1e6 + number(r["e2e_ms"])*1000)
				if end > result.EndTimeUs {
					result.EndTimeUs = end
				}
			}
		}
	}
	data, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, "comparison.json.tmp"), data, 0644); err != nil {
		return nil, err
	}
	if err := os.Rename(filepath.Join(dir, "comparison.json.tmp"), filepath.Join(dir, "comparison.json")); err != nil {
		return nil, err
	}
	return result, nil
}

func number(v any) float64 {
	if n, ok := v.(float64); ok {
		return n
	}
	return 0
}

func runSide(ctx context.Context, root, dir, policy string, c Config) (Side, error) {
	side := Side{Policy: policy}
	workdir := filepath.Join(dir, policy)
	if err := os.MkdirAll(workdir, 0755); err != nil {
		return side, err
	}
	routerName := policy + "-router.yaml"
	if c.Disaggregated {
		routerName = policy + "-pd-router.yaml"
	}
	router, err := os.ReadFile(filepath.Join(root, "configs", routerName))
	if err != nil {
		return side, err
	}
	files := map[string]string{"scenario.yaml": scenario(c), "workload.yaml": workload(c), "router.yaml": string(router)}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(workdir, name), []byte(data), 0644); err != nil {
			return side, err
		}
	}
	args := []string{"run", "--scenarios", workdir, "--scenario", "scenario.yaml", "--catalog", filepath.Join(root, ".runtime/blis-catalog"), "--registry", filepath.Join(root, ".runtime/blis-registry"), "--num-instances", strconv.Itoa(c.Instances), "--workload-spec", filepath.Join(workdir, "workload.yaml"), "--seed", strconv.Itoa(c.Seed), "--trace-level", "decisions", "--counterfactual-k", strconv.Itoa(c.Instances), "--trace-output", filepath.Join(workdir, "trace"), "--metrics-path", filepath.Join(workdir, "metrics.json"), "--log", "error"}
	if c.Disaggregated {
		args = append(args, "--prefill-instances", strconv.Itoa(c.PrefillInstances), "--decode-instances", strconv.Itoa(c.Instances-c.PrefillInstances), "--pd-transfer-contention")
	}
	command := exec.CommandContext(ctx, filepath.Join(root, ".runtime/bin/blis"), args...)
	command.Dir = filepath.Join(root, ".runtime/inference-sim")
	command.Env = append(os.Environ(), "BLIS_PLAYBACK_PATH="+filepath.Join(workdir, "playback.json"))
	manifest, _ := json.MarshalIndent(map[string]any{"binary": ".runtime/bin/blis", "args": args, "workingDirectory": command.Dir, "config": c, "policy": policy}, "", "  ")
	if err := os.WriteFile(filepath.Join(workdir, "run.json"), manifest, 0644); err != nil {
		return side, err
	}
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	err = command.Run()
	_ = os.WriteFile(filepath.Join(workdir, "run.log"), output.Bytes(), 0644)
	if err != nil {
		if ctx.Err() != nil {
			return side, fmt.Errorf("Simulation timed out or was cancelled. Reduce the request count or token lengths.")
		}
		return side, fmt.Errorf("BLIS %s run failed: %s", policy, output.String())
	}
	for name, target := range map[string]any{"metrics.json": &side.Metrics, "playback.json": &side.Playback} {
		data, err := os.ReadFile(filepath.Join(workdir, name))
		if err != nil {
			return side, err
		}
		if err := json.Unmarshal(data, target); err != nil {
			return side, fmt.Errorf("Read %s: %w", name, err)
		}
	}
	if err := verifyPools(c, side.Playback); err != nil {
		return side, err
	}
	side.Log = strings.TrimSpace(output.String())
	return side, nil
}

func scenario(c Config) string {
	if c.Disaggregated {
		return disaggregatedScenario(c)
	}
	return fmt.Sprintf(`kind: Scenario
name: comparison
engine_version: "0.31.0"
model: %s
coefficients: [cost-model-primitives, cost-model-collectives, cost-model-host-overheads, cost-model-attention, cost-model-recurrent, cost-model-memory]
cluster:
  hardware: %s
  nodes: 1
  gpus_per_node: %d
---
kind: Deployment
name: comparison
pools:
  - role: colocated
    nodes: 1
    parallel: {tp: 1, pp: 1, dp: 1, enable_expert_parallel: false}
    engine:
      quantization: ""
      cache_dtype: bfloat16
      block_size: 16
      max_num_batched_tokens: 8192
      max_num_seqs: 256
      max_model_len: %d
      cudagraph_mode: PIECEWISE
      gpu_memory_utilization: 0.9
router:
  endpoint_picker_config: router.yaml
`, c.Model, c.Hardware, c.Instances, deploymentOptions.ContextLimit)
}

func workload(c Config) string {
	if c.Workload == "agents" {
		return agentWorkload(c)
	}
	return fmt.Sprintf(`version: "2"
seed: %d
aggregate_rate: %g
num_requests: %d
clients:
  - id: example
    rate_fraction: 1.0
    prefix_group: shared-context
    prefix_length: %d
    arrival: {process: poisson}
    input_distribution:
      type: gaussian
      params: {mean: %d, std_dev: %g, min: 16, max: %d}
    output_distribution:
      type: gaussian
      params: {mean: %d, std_dev: %g, min: 16, max: %d}
`, c.Seed, c.Rate, c.Requests, c.PrefixTokens, c.InputTokens, float64(c.InputTokens)*0.25, c.InputTokens*2, c.OutputTokens, float64(c.OutputTokens)*0.25, c.OutputTokens*2)
}
