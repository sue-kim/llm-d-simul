package main

import (
	"math"
	"strings"
	"testing"
)

func TestValidateRejectsUnsafeOrUnsupportedRuns(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Config)
	}{
		{"unknown model", func(c *Config) { c.Model = "../../other" }},
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
