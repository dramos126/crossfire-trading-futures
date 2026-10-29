#!/usr/bin/env sh
# Builds and starts the app on http://localhost:3000; start.mjs does the work.
# Needs Node.js 22 or newer. `./start.sh --dev` runs the development server.
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 22 from https://nodejs.org and run this again." >&2
  exit 1
fi
exec node "$(dirname "$0")/start.mjs" "$@"
