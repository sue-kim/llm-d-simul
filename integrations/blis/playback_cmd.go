// Read-only export for llm-d-simul; inactive unless BLIS_PLAYBACK_PATH is set.
package cmd

import (
	"encoding/json"
	"os"
	"sort"

	"github.com/inference-sim/inference-sim/sim"
	"github.com/inference-sim/inference-sim/sim/cluster"
	"github.com/inference-sim/inference-sim/sim/trace"
	"github.com/sirupsen/logrus"
)

type playbackExport struct {
	Events    []sim.PlaybackEvent    `json:"events"`
	Snapshots []sim.ProgressSnapshot `json:"snapshots"`
	Decisions *trace.SimulationTrace `json:"decisions"`
}

var playback *playbackExport

func (p *playbackExport) OnProgress(snapshot sim.ProgressSnapshot) {
	p.Snapshots = append(p.Snapshots, snapshot)
}

func attachPlayback(cs *cluster.ClusterSimulator) {
	if os.Getenv("BLIS_PLAYBACK_PATH") == "" {
		return
	}
	playback = &playbackExport{Events: []sim.PlaybackEvent{}, Snapshots: []sim.ProgressSnapshot{}}
	sim.PlaybackObserver = func(e sim.PlaybackEvent) { playback.Events = append(playback.Events, e) }
	cs.SetProgressHook(playback, 50000)
}

func finishPlayback(cs *cluster.ClusterSimulator) {
	if playback == nil {
		return
	}
	sim.PlaybackObserver = nil
	playback.Decisions = cs.Trace()
	// Routing is recorded by BLIS itself. Export it separately from endpoint input
	// preparation, which finishes only when QueuedEvent fires.
	arrivals := map[string]sim.PlaybackEvent{}
	for _, e := range playback.Events {
		if e.Kind == "arrived" {
			arrivals[e.RequestID] = e
		}
	}
	if playback.Decisions != nil {
		for _, route := range playback.Decisions.Routings {
			e := arrivals[route.RequestID]
			e.Kind, e.TimeUs, e.InstanceID = "routed", route.Clock, route.ChosenInstance
			playback.Events = append(playback.Events, e)
		}
	}
	sort.SliceStable(playback.Events, func(i, j int) bool { return playback.Events[i].TimeUs < playback.Events[j].TimeUs })
	// A zero-duration routing decision belongs after its arrival but before any
	// endpoint events at that instant. Other equal-time event ordering is retained.
	for i := 0; i < len(playback.Events); {
		j := i + 1
		for j < len(playback.Events) && playback.Events[j].TimeUs == playback.Events[i].TimeUs {
			j++
		}
		priority := func(kind string) int {
			if kind == "arrived" {
				return 0
			}
			if kind == "routed" {
				return 1
			}
			return 2
		}
		sort.SliceStable(playback.Events[i:j], func(a, b int) bool { return priority(playback.Events[i+a].Kind) < priority(playback.Events[i+b].Kind) })
		i = j
	}
	data, err := json.Marshal(playback)
	if err == nil {
		err = os.WriteFile(os.Getenv("BLIS_PLAYBACK_PATH"), data, 0644)
	}
	if err != nil {
		logrus.Fatalf("Playback export failed: %v", err)
	}
}
