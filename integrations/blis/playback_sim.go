// Read-only playback instrumentation for llm-d-simul. No scheduling or RNG changes.
package sim

type PlaybackEvent struct {
	TimeUs       int64  `json:"timeUs"`
	RequestID    string `json:"requestId"`
	Kind         string `json:"kind"`
	InstanceID   string `json:"instanceId,omitempty"`
	InputTokens  int    `json:"inputTokens"`
	OutputTokens int    `json:"outputTokens"`
}

// PlaybackObserver receives value copies only; enabled explicitly by the CLI adapter.
var PlaybackObserver func(PlaybackEvent)

func ObservePlayback(req *Request, kind string, at int64) {
	if PlaybackObserver != nil {
		PlaybackObserver(PlaybackEvent{at, req.ID, kind, req.AssignedInstance, len(req.InputTokens), len(req.OutputTokens)})
	}
}
