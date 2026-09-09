FROM node:20-alpine

WORKDIR /app

# Copy root package.json
COPY package.json ./

# Copy contract package
COPY packages/contract ./packages/contract

# Copy gateway package
COPY backend/gateway/package.json ./backend/gateway/

# Install dependencies
RUN npm install --workspace=backend/gateway

# Copy gateway source
COPY backend/gateway/src ./backend/gateway/src
COPY backend/gateway/tsconfig.json ./backend/gateway/

# Start gateway
CMD ["npx", "tsx", "backend/gateway/src/index.ts"]