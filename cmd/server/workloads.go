package main

import "fmt"

type Fairness struct {
	Mode                  string `json:"mode"`
	MatchedRequests       int    `json:"matchedRequests"`
	IdenticalArrivalTimes bool   `json:"identicalArrivalTimes"`
}

func (c Config) plannedRequests() int {
	if c.Workload == "agents" {
		return c.Sessions * c.Turns
	}
	return c.Requests
}

func agentWorkload(c Config) string {
	// Each member draws one exponential start delay. BLIS divides the aggregate
	// rate among members, so this rate gives each session the requested mean.
	return fmt.Sprintf(`version: "2"
seed: %d
category: reasoning
aggregate_rate: %g
num_requests: %d
cohorts:
  - id: agents
    population: %d
    rate_fraction: 1.0
    prefix_group: agent-context
    prefix_sharing: per_member
    prefix_length: %d
    arrival: {process: poisson}
    input_distribution:
      type: gaussian
      params: {mean: %d, std_dev: %g, min: 16, max: %d}
    output_distribution:
      type: gaussian
      params: {mean: %d, std_dev: %g, min: 16, max: %d}
    reasoning:
      reason_ratio_distribution:
        type: constant
        params: {value: 0}
      multi_turn:
        max_rounds: %d
        think_time_us: %d
        context_growth: accumulate
        single_session: true
    closed_loop: true
    timeout: 0
`, c.Seed, float64(c.Sessions)*1000/float64(c.MeanStartMs), c.plannedRequests(), c.Sessions,
		c.PrefixTokens, c.InputTokens, float64(c.InputTokens)*0.25, c.InputTokens*2,
		c.OutputTokens, float64(c.OutputTokens)*0.25, c.OutputTokens*2, c.Turns, c.ThinkTimeMs*1000)
}

func eventKey(e Event) string {
	if e.SessionID != "" {
		return fmt.Sprintf("%s/turn/%d", e.SessionID, e.RoundIndex)
	}
	return e.RequestID
}

// Token hashes validate actual content, not just equal lengths. Follow-up BLIS
// request IDs contain a completion-order counter, so session/turn is the stable key.
func verifyWorkload(c Config, basic, llmd []Event) (Fairness, error) {
	f := Fairness{Mode: "identical-arrivals", IdenticalArrivalTimes: true}
	if c.Workload == "agents" {
		f.Mode = "matched-sessions"
	}
	fail := func(reason string) (Fairness, error) { return f, fmt.Errorf("Comparison refused: %s.", reason) }
	index := func(events []Event) (map[string]Event, map[string]int64, error) {
		arrivals, completed := map[string]Event{}, map[string]int64{}
		for _, e := range events {
			key := eventKey(e)
			if e.Kind == "arrived" {
				if _, exists := arrivals[key]; exists {
					return nil, nil, fmt.Errorf("duplicate request identity")
				}
				arrivals[key] = e
			}
			if e.Kind == "completed" {
				completed[key] = e.TimeUs
			}
		}
		return arrivals, completed, nil
	}
	a, ac, err := index(basic)
	if err != nil {
		return fail(err.Error())
	}
	b, bc, err := index(llmd)
	if err != nil {
		return fail(err.Error())
	}
	if len(a) != c.plannedRequests() || len(b) != len(a) {
		return fail("the planned request count was not preserved")
	}
	sessions := map[string]int{}
	for key, x := range a {
		y, exists := b[key]
		if !exists || x.ClientID != y.ClientID || x.InputTokens != y.InputTokens || x.OutputTokens != y.OutputTokens || x.InputHash == "" || x.OutputHash == "" || x.InputHash != y.InputHash || x.OutputHash != y.OutputHash {
			return fail("request identity or token content differed between policies")
		}
		if x.TimeUs != y.TimeUs {
			f.IdenticalArrivalTimes = false
		}
		if c.Workload != "agents" {
			if x.TimeUs != y.TimeUs {
				return fail("single-turn arrival times differed")
			}
			continue
		}
		if x.SessionID == "" || x.RoundIndex < 0 || x.RoundIndex >= c.Turns {
			return fail("invalid session or turn")
		}
		sessions[x.SessionID]++
		if x.RoundIndex == 0 {
			if x.TimeUs != y.TimeUs {
				return fail("session start times differed")
			}
			continue
		}
		previous := x
		previous.RoundIndex--
		prevKey := eventKey(previous)
		for _, side := range []struct {
			arrivals  map[string]Event
			completed map[string]int64
			current   Event
		}{{a, ac, x}, {b, bc, y}} {
			prev, ok := side.arrivals[prevKey]
			end, finished := side.completed[prevKey]
			if !ok || !finished || side.current.TimeUs != end+int64(c.ThinkTimeMs)*1000 {
				return fail("an agent turn did not follow its previous completion and pause")
			}
			if side.current.HistoryTokens != prev.InputTokens+prev.RetainedOutputTokens || prev.ContextHash == "" || side.current.HistoryHash != prev.ContextHash {
				return fail("an agent turn did not retain the previous input and output context")
			}
		}
	}
	if c.Workload == "agents" {
		if len(sessions) != c.Sessions {
			return fail("the planned session count was not preserved")
		}
		for _, count := range sessions {
			if count != c.Turns {
				return fail("a session has missing turns")
			}
		}
	}
	f.MatchedRequests = len(a)
	return f, nil
}
