#!/usr/bin/env bash
# Deprecated: use ./scripts/build.sh instead.
# This wrapper exists for backwards compatibility.
set -euo pipefail
echo "Note: build-xpi.sh is deprecated, use build.sh instead." >&2
exec "$(dirname "${BASH_SOURCE[0]}")/build.sh" "$@"
