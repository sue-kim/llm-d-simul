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
	"reflect"
	"strconv"
	"strings"
)

const adapterVersion = "1"

type Config struct {
	Workload     string  `json:"workload"`
	Model        string  `json:"model"`
	Hardware     string  `json:"hardware"`
	Instances    int     `json:"instances"`
	Requests     int     `json:"requests"`
	Rate         float64 `json:"rate"`
	InputTokens  int     `json:"inputTokens"`
	OutputTokens int     `json:"outputTokens"`
	PrefixTokens int     `json:"prefixTokens"`
	Seed         int     `json:"seed"`
}

func defaultConfig() Config {
	return Config{"chat", "llama-3.1-8b-instruct", "h100", 4, 256, 40, 256, 256, 512, 42}
}

func (c Config) Validate() error {
	if c.Workload != "chat" && c.Workload != "summarization" {
		return fmt.Errorf("Choose chat or summarization for this first integration.")
	}
	if c.Model != "llama-3.1-8b-instruct" {
		return fmt.Errorf("The first supported model is Llama 3.1 8B.")
	}
	if c.Hardware != "h100" {
		return fmt.Errorf("The first supported hardware is H100.")
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
	return nil
}

type Event struct {
	TimeUs       int64  `json:"timeUs"`
	RequestID    string `json:"requestId"`
	Kind         string `json:"kind"`
	InstanceID   string `json:"instanceId,omitempty"`
	InputTokens  int    `json:"inputTokens"`
	OutputTokens int    `json:"outputTokens"`
}
type Playback struct {
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
	Basic           Side            `json:"basic"`
	LLMD            Side            `json:"llmd"`
	EndTimeUs       int64           `json:"endTimeUs"`
	IdenticalInputs bool            `json:"identicalInputs"`
	Provenance      json.RawMessage `json:"provenance"`
	AdapterVersion  string          `json:"adapterVersion"`
	Assumptions     []string        `json:"assumptions"`
}

func compare(ctx context.Context, root string, config Config) (*Comparison, error) {
	lock, err := os.ReadFile(filepath.Join(root, "blis.lock.json"))
	if err != nil {
		return nil, err
	}
	hash := sha256.New()
	configJSON, _ := json.Marshal(config)
	hash.Write(configJSON)
	hash.Write(lock)
	hash.Write([]byte(adapterVersion))
	for _, name := range []string{"configs/basic-router.yaml", "configs/llmd-router.yaml", "cmd/server/compare.go", "integrations/blis/playback_cmd.go", "integrations/blis/playback_sim.go", "scripts/build-blis.py"} {
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
	result := &Comparison{ID: id, Config: config, Provenance: lock, AdapterVersion: adapterVersion,
		Assumptions: []string{
			"Synthetic workload; input length excludes the separately specified shared prefix.",
			"Both policies run inside BLIS's embedded llm-d router. Basic routing uses random endpoint selection.",
			"BF16 model and KV cache; one H100 per replica; cold caches; prefix caching enabled on both sides.",
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
	arrivals := func(events []Event) []Event {
		out := []Event{}
		for _, e := range events {
			if e.Kind == "arrived" {
				out = append(out, e)
			}
		}
		return out
	}
	a, b := arrivals(result.Basic.Playback.Events), arrivals(result.LLMD.Playback.Events)
	result.IdenticalInputs = len(a) == config.Requests && reflect.DeepEqual(a, b)
	if !result.IdenticalInputs {
		return nil, fmt.Errorf("Comparison refused: request IDs, arrivals, or token demands differed between policies.")
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
	router, err := os.ReadFile(filepath.Join(root, "configs", policy+"-router.yaml"))
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
	side.Log = strings.TrimSpace(output.String())
	return side, nil
}

func scenario(c Config) string {
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
      max_model_len: 32768
      cudagraph_mode: PIECEWISE
      gpu_memory_utilization: 0.9
router:
  endpoint_picker_config: router.yaml
`, c.Model, c.Hardware, c.Instances)
}

func workload(c Config) string {
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
