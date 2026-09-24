#!/usr/bin/env bash
# Start the OpenCommander HTTP MCP server (macOS / Linux).
set -euo pipefail
cd "$(dirname "$0")/../../.."
[ -f dist/opencommander/cli.js ] || npm run build
exec node dist/opencommander/cli.js serve "$@"
