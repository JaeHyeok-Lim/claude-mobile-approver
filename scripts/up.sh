#!/usr/bin/env bash
# Bring the bridge online + reachable from the phone (POSIX). Thin wrapper over up.mjs.
#   ./scripts/up.sh
#   ./scripts/up.sh --provider ngrok
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/up.mjs" "$@"
