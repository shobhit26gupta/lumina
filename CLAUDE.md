# LUMINA — Claude Code Context

## What this project is
A Perplexity-style AI search engine built as Assignment 1 
of the FDE Agent Engineering Bootcamp.

## Stack
- Node.js + TypeScript
- Express (gateway :8787, agent :8000)
- MongoDB Atlas
- OpenRouter API (NOT OpenAI directly)
- Tavily for web search

## Critical: OpenRouter setup
We use OpenRouter instead of OpenAI directly:
- Client: new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1" })
- LLM model: "openai/gpt-4o-mini"
- Embedding model: "baai/bge-m3" (1024 dims; OpenRouter has no HuggingFace sentence-transformers models — verified against its /models catalog)
- Image model: "dall-e-3" via OpenRouter
- DRY_RUN=true for image testing

## Architecture
Browser → Gateway (:8787) → Agent Service (:8000) → MongoDB

Gateway: CORS, auth (X-User-Id), rate limit, proxy only
Agent: loop, tools, memory, RAG, worker, artifacts

## Key files
- backend/agent/src/index.ts     — all routes
- backend/agent/src/loop.ts      — ReAct agent loop
- backend/agent/src/tools/index.ts — 5 tools
- backend/agent/src/searchCache.ts — 2-tier cache
- backend/agent/src/worker/index.ts — jobs worker
- backend/agent/src/worker/indexDocument.ts — PDF indexing
- backend/agent/src/worker/makeDeck.ts — pptx generation
- backend/agent/src/worker/makeImage.ts — image generation
- backend/gateway/src/index.ts   — gateway

## SSE streaming (critical)
POST /threads/:id/ask streams events in this ORDER:
1. trace (one per tool call)
2. sources (BEFORE first token)
3. token (one per word)
4. done (latency, cost, tokens)

## What's done
- DESIGN.md written
- Contract package
- Agent service (all routes + loop + tools)
- Gateway
- Worker (indexDocument + makeDeck + makeImage)
- searchCache (2-tier LRU + MongoDB TTL)

## What needs completing
- scripts/create-indexes.mjs
- benchmark/bench.mjs
- quality/check.mjs
- Deploy to Fly.io + Vercel

## Commands to run locally
Terminal 1: npx tsx backend/agent/src/index.ts
Terminal 2: npx tsx backend/gateway/src/index.ts
Test: curl http://localhost:8787/health

## Known issues fixed
- Gateway must NOT use express.json() — breaks proxy body stream
- All imports use ../db.js not ./db.js in tools folder
- .env must be in root folder not backend/agent/

## Deployment

### Fly.io (agent + gateway)
- Agent: backend/agent/fly.toml (internal only, no public port)
- Gateway: backend/gateway/fly.toml (public on 80/443)
- Secrets set via: fly secrets set KEY=value
- Never put secrets in fly.toml

### On personal PC — deployment order:
1. Install Fly CLI: curl -L https://fly.io/install.sh | sh
2. fly auth login
3. node scripts/create-indexes.mjs
4. cd backend/agent && fly launch && fly deploy
5. cd ../gateway && fly launch && fly deploy
6. Test: curl https://lumina-gateway.fly.dev/health
7. Deploy UI to Vercel (web/ folder)
8. Run benchmark: node benchmark/bench.mjs
9. Submit Vercel URL

### Environment variables (set as Fly secrets)
Agent needs:
  MONGODB_URI
  OPENROUTER_API_KEY  
  TAVILY_API_KEY

Gateway needs:
  AGENT_URL (the agent's Fly.io internal URL)