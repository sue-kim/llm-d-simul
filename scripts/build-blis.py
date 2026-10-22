#!/usr/bin/env python3
"""Apply bounded read-only instrumentation to the pinned source and compile it."""
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / ".runtime/inference-sim"
LOCK = json.loads((ROOT / "blis.lock.json").read_text())
for name, pin in LOCK["repositories"].items():
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT / ".runtime" / name, text=True).strip()
    if actual != pin["commit"]:
        raise RuntimeError(f"{name}: expected {pin['commit']}, found {actual}")


def patch(path, changes):
    # Always derive the adapter from the pinned commit, never patch a patch.
    original = subprocess.check_output(["git", "show", "HEAD:" + path], cwd=SOURCE, text=True)
    updated = original
    for old, new in changes:
        if updated.count(old) != 1:
            raise RuntimeError(f"Instrumentation anchor missing or ambiguous: {path}: {old}")
        updated = updated.replace(old, new)
    (SOURCE / path).write_text(updated)


patch("cmd/root.go", [
    ("\t\t\t\ttraceArrivals = append(traceArrivals, req)", "\t\t\t\ttraceArrivals = append(traceArrivals, req)\n\t\t\t\tsim.ObservePlayback(req, \"arrived\", req.ArrivalTime)"),
    ("\t\tif err := cs.Run(); err != nil {", "\t\tattachPlayback(cs)\n\t\tif err := cs.Run(); err != nil {"),
    ("\t\t// Surface any terminal sampler", "\t\tfinishPlayback(cs)\n\n\t\t// Surface any terminal sampler"),
])
patch("sim/event.go", [
    ("\tsim.EnqueueRequest(e.Request)", "\tsim.EnqueueRequest(e.Request)\n\tObservePlayback(e.Request, \"queued\", e.time)"),
    ("func (e *ScheduledEvent) Execute(sim *Simulator) {", "func (e *ScheduledEvent) Execute(sim *Simulator) {\n\tObservePlayback(e.Request, \"processing\", e.time)"),
    ("func (e *RequestLeftEvent) Execute(sim *Simulator) {", "func (e *RequestLeftEvent) Execute(sim *Simulator) {\n\tObservePlayback(e.Request, \"completed\", e.time)"),
    ("\te.Request.State = StateTimedOut", "\te.Request.State = StateTimedOut\n\tObservePlayback(e.Request, \"timed_out\", e.time)"),
])
patch("sim/simulator.go", [
    ("\t\t\tsim.Metrics.RequestTTFTs[req.ID] = float64(req.FirstTokenTime)", "\t\t\tsim.Metrics.RequestTTFTs[req.ID] = float64(req.FirstTokenTime)\n\t\t\tObservePlayback(req, \"streaming\", req.ArrivalTime+req.FirstTokenTime)"),
])
patch("sim/batch_formation.go", [
    ("\t\t\tpreemptedRequest.State = StateQueued", "\t\t\tpreemptedRequest.State = StateQueued\n\t\t\tObservePlayback(preemptedRequest, \"preempted\", ctx.Now)"),
])
for name, destination in [("playback_sim.go", "sim"), ("playback_cmd.go", "cmd")]:
    shutil.copyfile(ROOT / "integrations/blis" / name, SOURCE / destination / "playback_export.go")

(ROOT / ".runtime/bin").mkdir(exist_ok=True)
subprocess.run(["sh", str(ROOT / "scripts/go.sh"), "build", "-p", "4", "-o", str(ROOT / ".runtime/bin/blis"), "."], cwd=SOURCE, check=True)
print("BLIS adapter built.")
