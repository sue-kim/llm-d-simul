// Read-only projection of BLIS's child lifecycles onto original requests.
package cmd

import (
	"github.com/inference-sim/inference-sim/sim"
	"github.com/inference-sim/inference-sim/sim/cluster"
	"sort"
)

type playbackTransfer struct {
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

func normalizePDPlayback(cs *cluster.ClusterSimulator) {
	playback.Pools = map[string]string{}
	playback.Transfers = []playbackTransfer{}
	for id, role := range cs.PoolMembership() {
		playback.Pools[id] = role.String()
	}
	parents := cs.ParentRequests()
	if len(parents) == 0 {
		return
	}
	playback.RawEvents = playback.Events
	arrivals := map[string]sim.PlaybackEvent{}
	parentByID := map[string]*cluster.ParentRequest{}
	children := map[string]*cluster.ParentRequest{}
	for _, e := range playback.Events {
		if e.Kind == "arrived" {
			arrivals[e.RequestID] = e
		}
	}
	for _, p := range parents {
		parentByID[p.ID] = p
		children[p.PrefillSubReqID], children[p.DecodeSubReqID] = p, p
	}
	projected := []sim.PlaybackEvent{}
	for _, e := range playback.Events {
		if p := children[e.RequestID]; p != nil {
			// Prefill's first-token marker is not client-visible. Parent TTFT below
			// comes from BLIS's own projected metrics, after transfer/decode waiting.
			if e.Kind == "streaming" || e.Kind == "completed" || e.Kind == "timed_out" {
				continue
			}
			out := arrivals[p.ID]
			out.TimeUs, out.Kind, out.InstanceID, out.SubRequestID = e.TimeUs, e.Kind, e.InstanceID, e.RequestID
			out.Phase = "prefill"
			if e.RequestID == p.DecodeSubReqID {
				out.Phase = "decode"
			}
			if e.Kind == "processing" {
				out.Kind = "prefilling"
				if out.Phase == "decode" {
					out.Kind = "decoding"
				}
			}
			projected = append(projected, out)
		} else {
			if p := parentByID[e.RequestID]; p != nil && e.Kind == "routed" {
				e.InstanceID, e.Phase = string(p.PrefillInstanceID), "prefill"
			}
			projected = append(projected, e)
		}
	}
	metrics := cs.AggregatedMetrics()
	for _, p := range parents {
		add := func(kind, phase, instance, child string, at int64) {
			e := arrivals[p.ID]
			e.Kind, e.Phase, e.InstanceID, e.SubRequestID, e.TimeUs = kind, phase, instance, child, at
			projected = append(projected, e)
		}
		prefill, decode := string(p.PrefillInstanceID), string(p.DecodeInstanceID)
		if p.PrefillCompleteTime > 0 {
			add("kv_wait", "transfer", decode, "", p.PrefillCompleteTime)
		}
		if p.TransferCompleteTime > 0 && p.DecodeSubReq != nil {
			playback.Transfers = append(playback.Transfers, playbackTransfer{p.ID, prefill, decode, p.PrefillSubReqID, p.DecodeSubReqID, p.PrefillCompleteTime, p.TransferStartTime, p.TransferCompleteTime, p.TransferAloneTicks, p.NumKVBlocks, p.PulledKVBlocks})
			add("transferring", "transfer", "", "", p.TransferStartTime)
			add("kv_transferred", "transfer", decode, "", p.TransferCompleteTime)
		}
		if p.DecodeEnqueueTime > 0 {
			add("queued", "decode", decode, p.DecodeSubReqID, p.DecodeEnqueueTime)
		}
		if ttft, exists := metrics.RequestTTFTs[p.ID]; exists {
			add("streaming", "decode", decode, p.DecodeSubReqID, p.ArrivalTime+int64(ttft))
		}
		if p.CompletionTime > 0 {
			kind := "dropped"
			if p.DecodeSubReq != nil && p.DecodeSubReq.State == sim.StateCompleted {
				kind = "completed"
			}
			if (p.DecodeSubReq != nil && p.DecodeSubReq.State == sim.StateTimedOut) || (p.PrefillSubReq != nil && p.PrefillSubReq.State == sim.StateTimedOut) || p.OriginalRequest.State == sim.StateTimedOut {
				kind = "timed_out"
			}
			add(kind, "decode", decode, p.DecodeSubReqID, p.CompletionTime)
		}
	}
	sort.SliceStable(playback.Transfers, func(i, j int) bool { return playback.Transfers[i].StartUs < playback.Transfers[j].StartUs })
	playback.Events = projected
}

func pdEventPriority(e sim.PlaybackEvent) int {
	switch e.Kind {
	case "arrived":
		return 0
	case "routed":
		return 1
	case "queued", "preempted":
		if e.Phase == "decode" {
			return 7
		}
		return 2
	case "prefilling":
		return 3
	case "kv_wait":
		return 4
	case "transferring":
		return 5
	case "kv_transferred":
		return 6
	case "decoding":
		return 8
	case "streaming":
		return 9
	default:
		return 10
	}
}
