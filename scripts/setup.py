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
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime"
LOCK = json.loads((ROOT / "blis.lock.json").read_text())


def run(*args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, check=True)


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

    go = RUNTIME / "go" / "bin" / "go"
    if not go.exists():
        os_name = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
        arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64"}.get(platform.machine())
        if not os_name or not arch:
            raise RuntimeError("Setup supports macOS and Linux on arm64/amd64.")
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
        with tarfile.open(archive) as bundle:
            for member in bundle.getmembers():
                target = (RUNTIME / member.name).resolve()
                if RUNTIME.resolve() not in target.parents or member.issym() or member.islnk():
                    raise RuntimeError("Unsafe path in Go archive")
            bundle.extractall(RUNTIME)
        archive.unlink()
    run(str(go), "version")
    print("Pinned dependencies ready. Run npm run setup:build to compile the adapter.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Setup failed: {error}", file=sys.stderr)
        sys.exit(1)
