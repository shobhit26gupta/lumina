FROM node:20-alpine

WORKDIR /app

# Copy root package.json (workspaces)
COPY package.json ./

# Copy contract package
COPY packages/contract ./packages/contract

# Copy agent package
COPY backend/agent/package.json ./backend/agent/

# Install dependencies
RUN npm install --workspace=backend/agent

# Copy agent source
COPY backend/agent/src ./backend/agent/src
COPY backend/agent/tsconfig.json ./backend/agent/

# Create required directories
RUN mkdir -p runs reports

# Start with tsx (no build step needed)
CMD ["npx", "tsx", "backend/agent/src/index.ts"]