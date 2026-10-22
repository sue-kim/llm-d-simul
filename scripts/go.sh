#!/bin/sh
set -eu
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export GOPATH="$PROJECT_ROOT/.runtime/gopath"
export GOCACHE="$PROJECT_ROOT/.runtime/go-cache"
export GOTOOLCHAIN=local
exec "$PROJECT_ROOT/.runtime/go/bin/go" "$@"
