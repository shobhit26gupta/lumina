#!/bin/sh
# Runs agent + gateway in one Render free-tier container.
#
# The agent binds to 127.0.0.1 only (AGENT_BIND_HOST) — no public interface, no Fly-style
# private networking needed. Only the gateway, on Render's $PORT, is reachable from outside.
set -e

export AGENT_BIND_HOST=127.0.0.1
export AGENT_PORT=8000
export AGENT_URL=http://127.0.0.1:8000

npx tsx backend/agent/src/index.ts &
AGENT_PID=$!

# If the agent dies, the container should die too so Render restarts it — a gateway
# proxying to nothing is a worse failure mode than a clean restart.
trap "kill $AGENT_PID 2>/dev/null" EXIT

npx tsx backend/gateway/src/index.ts
