// Read-only playback instrumentation for llm-d-simul. No scheduling or RNG changes.
package sim

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
)

type PlaybackEvent struct {
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

// PlaybackObserver receives value copies only; enabled explicitly by the CLI adapter.
var PlaybackObserver func(PlaybackEvent)

// Observer-owned state only; never used by the engine or workload RNG.
var PlaybackHistoryTokens map[string]int

func playbackTokenHash(parts ...[]TokenID) string {
	h := sha256.New()
	var buf [8]byte
	for _, tokens := range parts {
		for _, token := range tokens {
			binary.LittleEndian.PutUint64(buf[:], uint64(token))
			h.Write(buf[:])
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

func ObservePlayback(req *Request, kind string, at int64) {
	if PlaybackObserver != nil {
		e := PlaybackEvent{TimeUs: at, RequestID: req.ID, Kind: kind, InstanceID: req.AssignedInstance,
			InputTokens: int(req.InputLen()), OutputTokens: len(req.OutputTokens), SessionID: req.SessionID, ClientID: req.ClientID, RoundIndex: req.RoundIndex}
		if kind == "arrived" {
			e.InputHash, e.OutputHash = playbackTokenHash(req.InputTokens), playbackTokenHash(req.OutputTokens)
			if req.SessionID != "" {
				e.HistoryTokens = req.PrefixLength
				if req.RoundIndex > 0 {
					e.HistoryTokens = PlaybackHistoryTokens[req.SessionID]
				}
				if e.HistoryTokens <= int(req.InputLen()) {
					e.HistoryHash = playbackTokenHash(req.InputTokens[:e.HistoryTokens])
				}
			}
		}
		PlaybackObserver(e)
	}
}

// Mirror the pinned SessionManager's retained-output boundary at completion.
// It uses ProgressIndex-InputLen, while generated-token metrics count the
// prefill-sampled token too. Preserve BLIS behavior rather than correcting it.
func ObservePlaybackRetainedContext(req *Request) {
	if PlaybackObserver == nil || req.SessionID == "" {
		return
	}
	retained := min(max(int(req.ProgressIndex-req.InputLen()), 0), len(req.OutputTokens))
	PlaybackHistoryTokens[req.SessionID] = int(req.InputLen()) + retained
	PlaybackObserver(PlaybackEvent{Kind: "context_retained", RequestID: req.ID,
		RetainedOutputTokens: retained, ContextHash: playbackTokenHash(req.InputTokens, req.OutputTokens[:retained])})
}
