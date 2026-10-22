package main

import "testing"

func TestAgentContextBudget(t *testing.T) {
	c := defaultConfig()
	c.Workload = "agents"
	c.Turns, c.PrefixTokens, c.InputTokens, c.OutputTokens = 8, 0, 1024, 1024
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.PrefixTokens++
	if c.Validate() == nil {
		t.Fatal("accepted possible context truncation")
	}
	c = defaultConfig()
	c.Workload = "agents"
	c.Sessions = 0
	if c.Validate() == nil {
		t.Fatal("accepted empty sessions")
	}
	c.Sessions = 1
	c.Turns = 9
	if c.Validate() == nil {
		t.Fatal("accepted excessive turns")
	}
	c = defaultConfig()
	c.Workload = "code"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestSessionMatchingUsesContentAndCausalTurns(t *testing.T) {
	c := defaultConfig()
	c.Workload = "agents"
	c.Sessions = 1
	c.Turns = 2
	c.ThinkTimeMs = 1
	first := Event{TimeUs: 100, RequestID: "first", Kind: "arrived", SessionID: "session", ClientID: "agents-0", InputTokens: 100, OutputTokens: 50, InputHash: "input-0", OutputHash: "output-0", ContextHash: "context-0", RetainedOutputTokens: 50}
	second := Event{TimeUs: 2000, RequestID: "followup-0", Kind: "arrived", SessionID: "session", ClientID: "agents-0", RoundIndex: 1, InputTokens: 200, OutputTokens: 50, InputHash: "input-1", OutputHash: "output-1", HistoryTokens: 150, HistoryHash: "context-0"}
	finished := first
	finished.Kind = "completed"
	finished.TimeUs = 1000
	a := []Event{first, finished, second}
	b := append([]Event(nil), a...)
	b[1].TimeUs = 1500
	b[2].TimeUs = 2500
	b[2].RequestID = "followup-7"
	f, err := verifyWorkload(c, a, b)
	if err != nil || f.IdenticalArrivalTimes || f.MatchedRequests != 2 || f.Mode != "matched-sessions" {
		t.Fatalf("valid matched sessions rejected: %+v %v", f, err)
	}
	for _, tc := range []struct {
		name   string
		mutate func([]Event)
	}{
		{"changed start", func(e []Event) { e[0].TimeUs++ }},
		{"early turn", func(e []Event) { e[2].TimeUs-- }},
		{"different token content", func(e []Event) { e[2].InputHash = "other" }},
		{"lost history", func(e []Event) { e[2].HistoryHash = "other" }},
		{"wrong history length", func(e []Event) { e[2].HistoryTokens-- }},
		{"duplicate turn", func(e []Event) { e[2].RoundIndex = 0 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			changed := append([]Event(nil), b...)
			tc.mutate(changed)
			if _, err := verifyWorkload(c, a, changed); err == nil {
				t.Fatal("invalid comparison accepted")
			}
		})
	}
	if _, err := verifyWorkload(c, a, b[:2]); err == nil {
		t.Fatal("missing turn accepted")
	}
}
