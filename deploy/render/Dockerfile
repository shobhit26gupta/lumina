FROM node:20-alpine

WORKDIR /app

# Root package.json (workspaces) + the shared contract
COPY package.json ./
COPY packages/contract ./packages/contract

# Agent + gateway packages
COPY backend/agent/package.json ./backend/agent/
COPY backend/gateway/package.json ./backend/gateway/

RUN npm install --workspace=backend/agent --workspace=backend/gateway

# Source
COPY backend/agent/src ./backend/agent/src
COPY backend/agent/tsconfig.json ./backend/agent/
COPY backend/gateway/src ./backend/gateway/src
COPY backend/gateway/tsconfig.json ./backend/gateway/

RUN mkdir -p runs reports

COPY deploy/render/start.sh ./start.sh
RUN chmod +x ./start.sh

# Render only routes to the port the platform assigns via $PORT — the agent binds to
# loopback only (see AGENT_BIND_HOST in start.sh) and is never reachable from outside
# this container.
CMD ["./start.sh"]
