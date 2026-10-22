package main

import "fmt"

type Transfer struct {
	RequestID           string `json:"requestId"`
	PrefillInstanceID   string `json:"prefillInstanceId"`
	DecodeInstanceID    string `json:"decodeInstanceId"`
	PrefillSubRequestID string `json:"prefillSubRequestId"`
	DecodeSubRequestID  string `json:"decodeSubRequestId"`
	PrefillCompleteUs   int64  `json:"prefillCompleteUs"`
	StartUs             int64  `json:"startUs"`
	EndUs               int64  `json:"endUs"`
	AloneUs             int64  `json:"aloneUs"`
	Blocks              int64  `json:"blocks"`
	PulledBlocks        int64  `json:"pulledBlocks"`
}

func (c Config) validatePools() error {
	if !c.Disaggregated {
		return nil
	}
	if c.PrefillInstances < 1 || c.PrefillInstances >= c.Instances {
		return fmt.Errorf("Assign at least one GPU to each pool within the total GPU budget.")
	}
	for _, network := range deploymentOptions.Networks {
		if network.ID == c.Fabric {
			return nil
		}
	}
	return fmt.Errorf("Choose a supported transfer network.")
}

func disaggregatedScenario(c Config) string {
	header := fmt.Sprintf(`kind: Scenario
name: comparison
engine_version: "0.31.0"
model: %s
coefficients: [cost-model-primitives, cost-model-collectives, cost-model-host-overheads, cost-model-attention, cost-model-recurrent, cost-model-memory]
cluster:
  hardware: %s
  fabric: %s
  nodes: %d
  gpus_per_node: 1
---
kind: Deployment
name: comparison
pools:
`, c.Model, c.Hardware, c.Fabric, c.Instances)
	for _, pool := range []struct {
		role  string
		count int
	}{{"prefill", c.PrefillInstances}, {"decode", c.Instances - c.PrefillInstances}} {
		header += fmt.Sprintf(`  - role: %s
    nodes: %d
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
`, pool.role, pool.count, deploymentOptions.ContextLimit)
	}
	return header + "pd_transfer:\n  connector: NixlConnector\nrouter:\n  endpoint_picker_config: router.yaml\n"
}

func verifyPools(c Config, playback Playback) error {
	if !c.Disaggregated {
		return nil
	}
	counts := map[string]int{}
	for _, role := range playback.Pools {
		counts[role]++
	}
	if len(playback.Pools) != c.Instances || counts["prefill"] != c.PrefillInstances || counts["decode"] != c.Instances-c.PrefillInstances {
		return fmt.Errorf("Comparison refused: recorded pools do not match the total GPU budget.")
	}
	for _, tr := range playback.Transfers {
		if playback.Pools[tr.PrefillInstanceID] != "prefill" || playback.Pools[tr.DecodeInstanceID] != "decode" || tr.StartUs < tr.PrefillCompleteUs || tr.EndUs <= tr.StartUs || tr.PulledBlocks > tr.Blocks {
			return fmt.Errorf("Comparison refused: invalid recorded KV transfer.")
		}
	}
	return nil
}
