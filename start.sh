#!/usr/bin/env sh
# Builds and starts the app on http://localhost:3000. Needs Node.js 22 with
# Corepack (it ships with Node); everything else is installed here.
#
#   ./start.sh            build, then start
#   ./start.sh --dev      the development server instead (rebuilds as you edit)
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 22 from https://nodejs.org and run this again." >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "Node.js $(node -v) is too old; this app needs Node.js 22 or newer." >&2
  exit 1
fi
if ! command -v corepack >/dev/null 2>&1; then
  echo "Corepack is missing. It ships with Node.js 22; on an older install run: npm install -g corepack" >&2
  exit 1
fi

if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "Created .env.local from .env.example. Every setting in it is optional; broker credentials are entered in the browser."
fi

corepack yarn install --frozen-lockfile

# Loopback only: the app has no login of its own, so anyone who can reach the
# port can trade the configured accounts.
if [ "${1:-}" = "--dev" ]; then
  exec corepack yarn dev -H 127.0.0.1 -p 3000
fi
corepack yarn build
echo
echo "Starting on http://localhost:3000 — Ctrl-C stops it."
exec corepack yarn start -H 127.0.0.1 -p 3000
