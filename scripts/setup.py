#!/usr/bin/env python3
"""Install pinned BLIS sources and a project-local Go toolchain."""
import hashlib
import json
import os
import platform
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime"
LOCK = json.loads((ROOT / "blis.lock.json").read_text())


def run(*args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, check=True)


def go_matches(go, expected):
    try:
        version = subprocess.check_output(
            [str(go), "version"], text=True, stderr=subprocess.STDOUT,
            env={**os.environ, "GOTOOLCHAIN": "local"}, timeout=15,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return False
    return version == expected


def main():
    RUNTIME.mkdir(exist_ok=True)
    for name, pin in LOCK["repositories"].items():
        dest = RUNTIME / name
        if not dest.exists():
            run("git", "clone", "--depth", "1", "--branch", pin["tag"],
                f"https://github.com/inference-sim/{name}.git", str(dest))
        actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=dest, text=True).strip()
        if actual != pin["commit"]:
            raise RuntimeError(f"{name}: expected {pin['commit']}, found {actual}")
        print(f"Verified {name} {pin['tag']} ({actual[:12]})", flush=True)

    os_name = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64"}.get(platform.machine())
    if not os_name or not arch:
        raise RuntimeError("Setup supports macOS and Linux on arm64/amd64.")
    go_dir = RUNTIME / "go"
    go = go_dir / "bin" / "go"
    expected = f"go version go{LOCK['go']} {os_name}/{arch}"
    if not go_matches(go, expected):
        if go_dir.exists():
            print(f"Replacing incompatible Go toolchain with Go {LOCK['go']} for {os_name}/{arch}", flush=True)
        filename = f"go{LOCK['go']}.{os_name}-{arch}.tar.gz"
        with urllib.request.urlopen("https://go.dev/dl/?mode=json&include=all", timeout=60) as response:
            releases = json.load(response)
        release = next(r for r in releases if r["version"] == f"go{LOCK['go']}")
        info = next(f for f in release["files"] if f["filename"] == filename)
        archive = RUNTIME / filename
        print(f"Downloading {filename}", flush=True)
        if not archive.exists():
            urllib.request.urlretrieve(f"https://go.dev/dl/{filename}", archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != info["sha256"]:
            raise RuntimeError("Go archive checksum mismatch")
        # Validate the replacement before touching the existing installation.
        with tempfile.TemporaryDirectory(prefix=".go-install-", dir=RUNTIME) as staging:
            staging = Path(staging)
            with tarfile.open(archive) as bundle:
                for member in bundle.getmembers():
                    target = (staging / member.name).resolve()
                    if staging.resolve() not in target.parents or not (member.isfile() or member.isdir()):
                        raise RuntimeError("Unsafe path in Go archive")
                bundle.extractall(staging)
            replacement = staging / "go"
            if not go_matches(replacement / "bin" / "go", expected):
                raise RuntimeError("Downloaded Go toolchain does not match the pinned version and host architecture")
            previous = staging / "previous-go"
            if go_dir.exists():
                go_dir.rename(previous)
            try:
                replacement.rename(go_dir)
            except OSError:
                if previous.exists():
                    previous.rename(go_dir)
                raise
        archive.unlink()
    print(expected, flush=True)
    print("Pinned dependencies ready. Run npm run setup:build to compile the adapter.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Setup failed: {error}", file=sys.stderr)
        sys.exit(1)
