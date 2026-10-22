package main

import (
	"encoding/json"
	"math"
	"os"
	"strings"
	"testing"
)

func TestValidateRejectsUnsafeOrUnsupportedRuns(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Config)
	}{
		{"unknown model", func(c *Config) { c.Model = "../../other" }},
		{"unsupported multi-GPU model", func(c *Config) { c.Model = "llama-3.1-70b-instruct" }},
		{"unknown hardware", func(c *Config) { c.Hardware = "b300" }},
		{"unsupported sessions", func(c *Config) { c.Workload = "agents" }},
		{"unbounded request count", func(c *Config) { c.Requests = 100000 }},
		{"nonfinite traffic", func(c *Config) { c.Rate = math.Inf(1) }},
		{"missing hardware allocation", func(c *Config) { c.Instances = 0 }},
		{"negative prefix", func(c *Config) { c.PrefixTokens = -1 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := defaultConfig()
			tc.mutate(&c)
			if c.Validate() == nil {
				t.Fatal("invalid run accepted")
			}
		})
	}
	if err := defaultConfig().Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestSupportedDeploymentMatrix(t *testing.T) {
	for _, model := range deploymentOptions.Models {
		for _, hardwareID := range model.HardwareIDs {
			t.Run(model.ID+"/"+hardwareID, func(t *testing.T) {
				c := defaultConfig()
				c.Model, c.Hardware = model.ID, hardwareID
				if err := c.Validate(); err != nil {
					t.Fatal(err)
				}
				deployment, err := resolveDeployment(c.Model, c.Hardware)
				if err != nil {
					t.Fatal(err)
				}
				if deployment.Hardware.MemoryGiB <= 0 || deployment.ContextLimit > model.NativeContextTokens || deployment.GPUsPerInstance != 1 {
					t.Fatal("unsupported precision, capacity, or context allocation")
				}
				yaml := scenario(c)
				for _, expected := range []string{"model: " + model.ID + "\n", "hardware: " + hardwareID + "\n", "gpus_per_node: 4\n", "tp: 1", "cache_dtype: bfloat16"} {
					if !strings.Contains(yaml, expected) {
						t.Fatalf("scenario missing %q", expected)
					}
				}
			})
		}
	}
}

func TestDeploymentSnapshotMatchesCatalogPin(t *testing.T) {
	data, err := os.ReadFile("../../blis.lock.json")
	if err != nil {
		t.Fatal(err)
	}
	var lock struct {
		Repositories map[string]struct{ Commit string }
	}
	if err := json.Unmarshal(data, &lock); err != nil {
		t.Fatal(err)
	}
	if lock.Repositories["blis-catalog"].Commit != deploymentOptions.CatalogCommit {
		t.Fatal("regenerate deployments.json after updating the catalog pin")
	}
}

func TestScenarioBudgetAndContextBounds(t *testing.T) {
	c := defaultConfig()
	c.Instances = 8
	c.InputTokens = 8192
	c.OutputTokens = 2048
	c.PrefixTokens = 4096
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if maxDemand := 2*c.InputTokens + 2*c.OutputTokens + c.PrefixTokens; maxDemand > 32768 {
		t.Fatalf("accepted workload can exceed context: %d", maxDemand)
	}
	yaml := scenario(c)
	if !strings.Contains(yaml, "gpus_per_node: 8") || !strings.Contains(yaml, "tp: 1") {
		t.Fatal("replica allocation no longer matches GPU budget")
	}
}
