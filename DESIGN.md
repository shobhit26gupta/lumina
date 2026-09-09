# LUMINA — System Design

> Assignment 1, FDE Agent Engineering Bootcamp
> Author: [Your Name]

---

## Question 1: Components & Responsibilities

LUMINA has five components. Each has one job and does not cross into another's territory.

### React UI (`web/`)
The browser interface — provided, not built by me. The user types questions here, sees streaming answers with citation chips `[1]` `[2]`, manages Spaces, uploads documents, and triggers deck or image generation. It talks only to the Gateway, never directly to the Agent Service.

### Express Gateway (`backend/gateway/` — port 8787)
The public-facing traffic cop. Every browser request lands here first. It:
- Validates that `X-User-Id` is present (returns `401` if not)
- Validates request body shapes using Zod schemas from `packages/contract`
- Applies rate limiting (100 requests/minute per user)
- Logs every request with a structured `X-Request-Id`
- Passes SSE streams through to the browser without buffering
- Serves the built React UI from `web/dist`

It holds **no API keys** and does **no AI work**.

### Express Agent Service (`backend/agent/` — port 8000)
The brain. Never exposed to the public internet — only the Gateway can reach it. It:
- Runs the agent loop (plan → search → observe → repeat → answer)
- Holds all provider API keys (OpenRouter, Tavily/SerpApi)
- Manages the five tools: `web_search`, `fetch_page`, `search_documents`, `recall_memory`, `save_memory`
- Streams SSE events (`trace → sources → tokens → done`) back through the Gateway
- Runs the background jobs worker for document indexing, deck generation, and image generation
- Writes run logs to `runs/<requestId>.json` and the `runs` MongoDB collection

### MongoDB Atlas (single cluster)
The single source of truth for all state. Stores:
- Conversations (`threads`, `messages`)
- Long-term memory (`memories`) with a vector index
- Document spaces and indexed chunks (`spaces`, `documents`, `chunks`) with vector + text indexes
- Search result cache (`searchCache`) with a TTL index that auto-expires entries after 6 hours
- Background jobs queue (`jobs`)
- Generated artifacts metadata (`artifacts`)
- Request and run logs (`requests`, `runs`)
- Raw files via GridFS (`uploads` bucket for PDFs, `files` bucket for generated .pptx and .png)

### External Providers
- **OpenRouter** — LLM completions (`openai/gpt-4o-mini`), embeddings (`baai/bge-m3`), image generation (`dall-e-3`). One API key, one billing account, instead of talking to OpenAI directly — this project's own house rule (see `CLAUDE.md`). OpenRouter has no HuggingFace-style embedding models, so `baai/bge-m3` (1024 dims) is the embedding model, not an OpenAI one.
- **Tavily / SerpApi** — live web search (swappable via `SEARCH_PROVIDER` environment variable)

---

## Question 2: Why Two Services?

Browser-facing concerns and AI concerns change for different reasons and fail for different reasons. Splitting them is the correct engineering habit.

**Gateway concerns (edge):** CORS, auth, request shape validation, rate limiting, logging, serving static files. These are infrastructure problems. They have nothing to do with prompts or tokens.

**Agent Service concerns (AI):** Prompt construction, tool routing, token budgets, cost tracking, provider keys. These are AI problems. They have nothing to do with CORS headers.

**Three concrete reasons to keep them separate:**

1. **Security** — The Agent Service runs on Fly.io's private network. It has no public IP. A browser cannot reach it even if it wanted to. API keys live in the Agent Service's environment variables and are physically unreachable from the browser's network tab.

2. **Independent failure** — If the Agent Service restarts mid-deployment, the Gateway can return a clean `502` immediately instead of the browser hanging. The Gateway never crashes because the LLM provider is slow.

3. **Independent scaling** — In production you could run 3 Agent Service instances behind one Gateway without touching the Gateway code.

---

## Question 3: Communication

### Most routes — standard HTTP request/response
```
Browser → Gateway → Agent Service → MongoDB
                  ← JSON response
```
Used for: `POST /threads`, `POST /spaces`, `GET /memory`, `POST /artifacts`, `GET /health`, `GET /stats`.

These are fast (< 300 ms) because the work is lightweight or deferred to the jobs worker.

### The `/ask` route — SSE streaming
```
Browser → Gateway → Agent Service (keeps connection open)
        ←───────── SSE events stream back, one at a time
```

The Agent Service writes SSE events in this strict order:
1. `trace` — one per tool call ("I searched the web, took 340 ms, ok")
2. `sources` — the full list of citations **before the first word of the answer**
3. `token` — one per word/chunk of the answer
4. `done` — latency, TTFT, token count, cost, `terminated` status

**Why sources before tokens?** The React UI renders citation chips `[1]` inline as words stream in. If sources arrived after the words, the UI would not know what `[1]` refers to while displaying it.

### Buffering prevention (critical)
The Gateway must not accidentally collect all SSE events and send them at once. Three things prevent this:
- Compression disabled on the `/ask` route (compression requires buffering)
- `X-Accel-Buffering: no` header set
- `res.flushHeaders()` called immediately when the SSE connection opens

---

## Question 4: State — Where Data Lives

All persistent state lives in MongoDB Atlas. One database, one connection string, one thing to operate.

### Why one database for everything including vectors?

Most AI systems split across: PostgreSQL (data) + Pinecone (vectors) + S3 (files) + Redis (cache). That is four systems to keep in sync, four potential failure points, four billing accounts.

MongoDB Atlas handles all of it because:
- **The embedding lives in the same document** as the chunk text and its page locator, whether it's queried through Atlas `$vectorSearch` or, as currently deployed, a brute-force cosine scan (`mongo-cosine-scan`, `/health` names it) — a citation is one document either way, no join across systems.
- **TTL indexes** auto-expire search cache entries after 6 hours — no cron job needed.
- **GridFS** stores binary files (PDFs, .pptx, .png) natively inside MongoDB.
- **Atlas Search (BM25) + RRF fusion is the designed upgrade path**, not what's live today. Retrieval currently runs semantic-only: embed the query, cosine-score it against every chunk in the Space in application code, take the top 5. `scripts/indexes.json` already defines the `chunks_vector` (vector) and `chunks_text` (BM25) Atlas Search indexes for the day this gets wired up to real hybrid retrieval.

### Data flow for a PDF upload:
```
Upload arrives
  → GridFS (uploads): raw PDF stored
  → documents collection: status = "pending"
  → jobs collection: "index_document" job queued
  → 202 returned immediately (< 300 ms)

Background worker picks up job:
  → PDF parsed page by page (pdfjs-dist)
  → Each page chunked into ~800-token pieces with overlap
  → Each chunk embedded (baai/bge-m3, via OpenRouter → 1024 numbers)
  → chunks collection: text + locator + embedding stored
  → documents collection: status = "indexed"
```

### Data flow for a query:
```
Query arrives
  → memories: recalled by recency, 10 most recent (what does this user prefer?)
     [semantic recall is designed but not wired up yet — MemoryDoc has an
      embedding field, but recallMemory() doesn't query by vector similarity]
  → messages: thread history loaded (what was said before?)
  → chunks: semantic + keyword search (what does the document say?)
  → messages: answer + sources saved
  → runs: agent loop log saved
  → requests: request metadata saved
```

---

## Question 5: Trade-offs

### 1. One MongoDB vs. specialized tools
**Chose:** MongoDB for everything.
**Gain:** Simplicity — one system, one connection, citations are single documents.
**Give up:** Specialized vector DBs (Pinecone, Qdrant) have richer ANN features and are faster at billion-scale. Right now I'm also giving up Atlas's own ANN index — retrieval is a brute-force cosine scan over each Space's chunks in application code (`mongo-cosine-scan`), not `$vectorSearch`, so it doesn't scale past a few thousand chunks per Space either.
**Why right here:** The workload is a handful of documents per Space, not billions of chunks. A linear scan is fast enough at this scale, the operational simplicity of not standing up a second system is worth more than ANN performance I don't need yet, and the upgrade path to Atlas Vector Search is a config change (`scripts/indexes.json` already has the index definitions), not a rewrite.

### 2. In-process jobs worker vs. Redis + BullMQ
**Chose:** Worker runs inside the Agent Service using MongoDB as the queue.
**Gain:** No extra infrastructure. MongoDB's `findOneAndUpdate` gives atomic job claiming — no two workers pick the same job. Retry logic (3 attempts) handles crashes.
**Give up:** Cannot scale workers independently of the API. A long PDF indexing job competes with request handling on the same process.
**Why right here:** For a 2-week project with moderate document volume, the simplicity of no extra infrastructure outweighs the scaling limitation.

### 3. Two-tier search cache vs. no cache
**Chose:** L1 in-memory LRU (500 entries) + L2 MongoDB TTL (6 hours).
**Gain:** Repeated queries return instantly — no Tavily API call, no cost, very low latency. Benchmark requires ≥ 50% cache hit rate; this achieves it with the repeated-query workload.
**Give up:** Results can be up to 6 hours stale. Time-sensitive queries ("breaking news today") must bypass the cache.
**Why right here:** Most research queries don't change hour to hour. The time-sensitivity detector (`isTimeSensitive()`) bypasses cache for queries containing "today", "latest", "breaking", etc.

### 4. TypeScript/MERN vs. Python/FastAPI
**Chose:** Full TypeScript stack (despite Python being my primary language as a Data Scientist).
**Gain:** The provided React UI, contract package, and type schemas are all TypeScript. Using the same language means zero translation errors between the contract and the implementation. SSE streaming is natural in Node.js.
**Give up:** Python is more comfortable for me. TypeScript has a learning curve, especially async patterns.
**Why right here:** The contract is already TypeScript. All the AI work is API calls (OpenAI SDK, Tavily HTTP) — no custom ML code that would benefit from Python's ecosystem. Matching the provided stack is the right engineering decision.

---

## How I ran it

- **LLM:** `openai/gpt-4o-mini` via **OpenRouter** (cost-efficient, fast, sufficient for search-and-synthesize tasks; OpenRouter instead of OpenAI directly, per this project's own house rule)
- **Search provider:** Tavily (advanced search depth)
- **Embedding model:** `baai/bge-m3` via OpenRouter, 1024 dims. Not an OpenAI model — OpenRouter doesn't host any embedding models under an OpenAI-compatible name, checked against its full model catalog, so this was the closest fit to the originally-planned HuggingFace sentence-transformer model.
- **Vector backend (currently live, local and deployed):** `mongo-cosine-scan` — application-code cosine similarity over each Space's chunks, no Atlas Search index yet.
- **Vector backend (upgrade path, not yet wired up):** Atlas Vector Search with the `chunks_vector` index (cosine, 1024 dims, filtered by `spaceId`) — already defined in `scripts/indexes.json`, just not queried by the retrieval code yet.
- **Atlas tier:** [confirm your actual cluster tier in the Atlas dashboard — not verifiable from a DB connection string]. A paid tier is only required once `$vectorSearch`/`$search` are actually wired up; the current `mongo-cosine-scan` backend runs on any tier including the free M0.
- **Image model:** `dall-e-3` via OpenRouter, with `DRY_RUN=true` for testing without spend.
