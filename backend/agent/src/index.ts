import "dotenv/config";
import express from "express";
import multer from "multer";
import { Readable } from "stream";
import { connectDB, col, getGridUploads, getGridFiles } from "./db.js";
import { genId, calcCost, nowIso } from "./utils.js";
import { runAgentLoop } from "./loop.js";
import { startWorker } from "./worker/index.js";

const app    = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits:  { fileSize: 25 * 1024 * 1024 } // 25MB max
});

app.use(express.json());

const PORT  = parseInt(process.env.AGENT_PORT ?? "8000");
const MODEL = process.env.LLM_MODEL ?? "openai/gpt-4o-mini";

// ── Health ───────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await col.threads().findOne({});
    res.json({
      status:         "ok",
      model:          MODEL,
      searchProvider: process.env.SEARCH_PROVIDER ?? "tavily",
      vectorStore:    process.env.VECTOR_BACKEND  ?? "mongo-cosine-scan",
      db:             "ok",
      ai:             { status: "ok" },
    });
  } catch (e: any) {
    res.status(503).json({ 
      status: "degraded", 
      db:     "error", 
      error:  e.message 
    });
  }
});

// ── Stats ────────────────────────────────────────────────────
app.get("/stats", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [requests, answers, todayRequests, images, deepToday] = await Promise.all([
    col.requests().countDocuments({}),
    col.messages().countDocuments({ role: "assistant" }),
    col.requests().find({ createdAt: { $gte: today } }).toArray(),
    col.artifacts().countDocuments({
      kind: "image",
      createdAt: { $gte: today }
    }),
    col.runs().countDocuments({ userId, depth: "deep", createdAt: { $gte: today } }),
  ]);

  const costToday = todayRequests.reduce(
    (acc: number, r: any) => acc + (r.costUsd ?? 0), 0
  );
  const ttfts = todayRequests
    .map((r: any) => r.ttftMs)
    .filter(Boolean)
    .sort((a: number, b: number) => a - b);
  const p95idx = Math.floor(ttfts.length * 0.95);

  res.json({
    requests,
    answers,
    searchCacheHitRatePct: 0,
    ttftP95Ms:    ttfts[p95idx] ?? 0,
    costUsdToday: Math.round(costToday * 10000) / 10000,
    imagesToday:  images,
    imageDailyCap: parseInt(process.env.IMAGE_DAILY_CAP ?? "10"),
    deepToday,
    deepDailyCap: parseInt(process.env.DEEP_DAILY_CAP ?? "5"),
  });
});

// ── Threads ──────────────────────────────────────────────────
app.post("/threads", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "X-User-Id required" });

  const threadId = genId("thr");
  await col.threads().insertOne({
    _id:       threadId,
    userId,
    title:     req.body.title ?? "New thread",
    createdAt: new Date(),
  });
  res.status(201).json({ threadId });
});

app.get("/threads", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "X-User-Id required" });

  const threads = await col.threads()
    .find({ userId })
    .sort({ createdAt: -1 })
    .toArray();

  res.json({
    threads: threads.map((t: any) => ({
      threadId:  t._id,
      title:     t.title,
      createdAt: t.createdAt,
    })),
  });
});

app.get("/threads/:id", async (req, res) => {
  const thread = await col.threads().findOne({ _id: req.params.id });
  if (!thread) return res.status(404).json({ error: "thread not found" });

  const messages = await col.messages()
    .find({ threadId: req.params.id })
    .sort({ createdAt: 1 })
    .toArray();

  res.json({
    messages: messages.map((m: any) => ({
      role:      m.role,
      content:   m.content,
      sources:   m.sources     ?? [],
      artifacts: m.artifactIds ?? [],
      createdAt: m.createdAt,
    })),
  });
});

// ── Ask (SSE streaming) ──────────────────────────────────────
app.post("/threads/:id/ask", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "X-User-Id required" });

  const { query, mode = "auto", depth = "quick", spaceId } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  // Deep search costs several times a quick search — a per-user daily cap, same shape as
  // the image daily cap, so a runaway deep habit can't run away with the budget.
  if (depth === "deep") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cap   = parseInt(process.env.DEEP_DAILY_CAP ?? "5");
    const count = await col.runs().countDocuments({
      userId, depth: "deep", createdAt: { $gte: today },
    });
    if (count >= cap) {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return res.status(429).json({
        error:    "Daily deep search cap reached",
        resetsAt: tomorrow.toISOString(),
      });
    }
  }

  const requestId = (req.headers["x-request-id"] as string)
                    ?? genId("req");

  await col.messages().insertOne({
    _id:       genId("msg"),
    threadId:  req.params.id,
    role:      "user",
    content:   query,
    createdAt: new Date(),
  });

  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    await runAgentLoop({
      requestId,
      threadId: req.params.id,
      userId,
      query,
      mode,
      depth,
      spaceId,
      res,
    });
  } catch (e: any) {
    console.error("[agent] ask failed:", e?.error ?? e);
    res.write(
      `event: error\ndata: ${JSON.stringify({
        status: 502,
        error:  e.message,
      })}\n\n`
    );
  }
  res.end();
});

// ── Memory ───────────────────────────────────────────────────
app.get("/memory", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "X-User-Id required" });

  const memories = await col.memories()
    .find({ userId })
    .sort({ createdAt: -1 })
    .toArray();

  res.json({
    memories: memories.map((m: any) => ({
      id:           m._id,
      text:         m.text,
      sourceThread: m.sourceThread,
      createdAt:    m.createdAt,
    })),
  });
});

app.delete("/memory/:id", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "X-User-Id required" });
  await col.memories().deleteOne({ _id: req.params.id, userId });
  res.status(204).end();
});

// ── Spaces ───────────────────────────────────────────────────
app.post("/spaces", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "X-User-Id required" });

  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });

  const spaceId = genId("spc");
  await col.spaces().insertOne({
    _id: spaceId, userId, name, createdAt: new Date(),
  });
  res.status(201).json({ spaceId, name });
});

app.get("/spaces", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "X-User-Id required" });

  const spaces = await col.spaces()
    .find({ userId })
    .sort({ createdAt: -1 })
    .toArray();

  res.json({
    spaces: spaces.map((s: any) => ({
      spaceId:   s._id,
      name:      s.name,
      createdAt: s.createdAt,
    })),
  });
});

// ── Documents (RAG) ──────────────────────────────────────────
app.post("/spaces/:id/documents", 
  upload.single("file"), 
  async (req, res) => {
    const userId = req.headers["x-user-id"] as string;
    if (!userId) return res.status(401).json({ error: "X-User-Id required" });
    if (!req.file) return res.status(400).json({ error: "file required" });

    const spaceId = req.params.id;
    const docId   = genId("doc");
    const fileId  = genId("fid");

    // Store raw file in GridFS
    const bucket = getGridUploads();
    const uploadStream = bucket.openUploadStreamWithId(
      fileId as any, 
      req.file.originalname,
      { metadata: { docId, spaceId, userId } }
    );

    await new Promise<void>((resolve, reject) => {
      Readable.from(req.file!.buffer)
        .pipe(uploadStream)
        .on("finish", resolve)
        .on("error",  reject);
    });

    // Create document record
    await col.documents().insertOne({
      _id:       docId,
      spaceId,
      userId,
      title:     req.file.originalname,
      status:    "pending",
      pct:       0,
      fileId,
      createdAt: new Date(),
    });

    // Queue indexing job
    await col.jobs().insertOne({
      kind:      "index_document",
      status:    "pending",
      payload:   { 
        docId, spaceId, userId, 
        fileId, 
        mimetype: req.file.mimetype 
      },
      attempts:  0,
      createdAt: new Date(),
    });

    // Return 202 immediately — work happens in background
    res.status(202).json({ docId, status: "pending" });
  }
);

app.get("/spaces/:id/documents", async (req, res) => {
  const docs = await col.documents()
    .find({ spaceId: req.params.id })
    .toArray();

  res.json({
    documents: docs.map((d: any) => ({
      docId:  d._id,
      title:  d.title,
      status: d.status,
      pct:    d.pct,
      pages:  d.pages,
      error:  d.error,
    })),
  });
});

// ── Artifacts ────────────────────────────────────────────────
app.post("/artifacts", async (req, res) => {
  const userId = req.headers["x-user-id"] as string;
  if (!userId) return res.status(401).json({ error: "X-User-Id required" });

  const { kind, threadId, answerId, prompt } = req.body;
  if (!kind || !threadId) {
    return res.status(400).json({ error: "kind and threadId required" });
  }

  // Check image daily cap
  if (kind === "image") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cap   = parseInt(process.env.IMAGE_DAILY_CAP ?? "10");
    const count = await col.artifacts().countDocuments({ 
      userId, kind: "image", 
      createdAt: { $gte: today } 
    });
    if (count >= cap) {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return res.status(429).json({ 
        error:    "Daily image cap reached", 
        resetsAt: tomorrow.toISOString() 
      });
    }
  }

  const artifactId = genId("art");

  // Create artifact record
  await col.artifacts().insertOne({
    _id:        artifactId,
    userId,
    threadId,
    answerId,
    kind,
    status:     "pending",
    promptUsed: prompt,
    createdAt:  new Date(),
  });

  // Queue job
  await col.jobs().insertOne({
    kind:      kind === "deck" ? "make_deck" : "make_image",
    status:    "pending",
    payload:   { artifactId, threadId, answerId, prompt, userId },
    attempts:  0,
    createdAt: new Date(),
  });

  // Return 202 immediately
  res.status(202).json({ artifactId, kind, status: "pending" });
});

app.get("/artifacts/:id", async (req, res) => {
  const artifact = await col.artifacts().findOne({ _id: req.params.id });
  if (!artifact) return res.status(404).json({ error: "not found" });

  res.json({
    artifactId:  artifact._id,
    kind:        artifact.kind,
    status:      artifact.status,
    url:         artifact.status === "ready" 
                 ? `/artifacts/${artifact._id}/file` 
                 : undefined,
    outline:     artifact.outline,
    promptUsed:  artifact.promptUsed,
    model:       artifact.model,
    costUsd:     artifact.costUsd,
    error:       artifact.error,
  });
});

app.get("/artifacts/:id/file", async (req, res) => {
  const artifact = await col.artifacts().findOne({ _id: req.params.id });
  if (!artifact || artifact.status !== "ready") {
    return res.status(404).json({ error: "not ready" });
  }

  const bucket   = getGridFiles();
  const mimetype = artifact.kind === "deck"
    ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    : "image/png";
  const ext = artifact.kind === "deck" ? "pptx" : "png";

  res.setHeader("Content-Type", mimetype);
  res.setHeader(
    "Content-Disposition", 
    `attachment; filename="${artifact._id}.${ext}"`
  );
  bucket.openDownloadStream(artifact.fileId as any).pipe(res);
});

// ── Evals report ─────────────────────────────────────────────
app.get("/evals/report.json", async (req, res) => {
  try {
    const { readFile } = await import("fs/promises");
    const report = JSON.parse(
      await readFile("reports/report.json", "utf8")
    );
    res.json(report);
  } catch {
    res.status(404).json({
      error: "No eval report yet. Run: node eval/build-report.mjs (see .claude/skills/fde-lumina-eval)"
    });
  }
});

// ── Boot ─────────────────────────────────────────────────────
// Fly.io keeps the agent unreachable via private networking (no public port in fly.toml),
// so it binds every interface there. A combined single-container deploy (e.g. Render's
// free tier, which has no private-service option) has no such network-level isolation —
// AGENT_BIND_HOST=127.0.0.1 makes the agent unreachable from outside that container by
// simply never listening on a public interface at all.
const HOST = process.env.AGENT_BIND_HOST ?? "0.0.0.0";
connectDB().then(() => {
  app.listen(PORT, HOST, () => {
    console.log(`[agent] listening on ${HOST}:${PORT}`);
  });
  startWorker(); // start background jobs worker
}).catch((e) => {
  console.error("[agent] failed to connect to DB:", e.message);
  process.exit(1);
});