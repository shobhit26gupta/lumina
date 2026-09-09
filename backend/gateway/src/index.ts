import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { randomBytes } from "crypto";
import { AskBody, ThreadId, AnswerId } from "@lumina/contract";
import { z } from "zod";

// Not part of @lumina/contract's http.ts (which only covers ask/threads/memory/spaces) —
// PRD 7 still specifies this request shape, so it's validated here at the gateway.
const CreateArtifactBody = z.object({
  kind: z.enum(["deck", "image"]),
  threadId: ThreadId,
  answerId: AnswerId.optional(),
  prompt: z.string().optional(),
});

const app = express();

// ── CORS ─────────────────────────────────────────────────────
// Allow browser requests from any origin
app.use(cors({ 
  origin: "*", 
  exposedHeaders: ["X-Request-Id"] 
}));

// ── Request ID ───────────────────────────────────────────────
// Every request gets a unique ID for tracing across both logs
app.use((req: Request, res: Response, next: NextFunction) => {
  const id = (req.headers["x-request-id"] as string) 
             ?? `req_${randomBytes(6).toString("hex")}`;
  req.headers["x-request-id"] = id;
  res.setHeader("X-Request-Id", id);
  next();
});

// ── Auth guard ───────────────────────────────────────────────
// Every route except /health and GET /evals/report.json needs X-User-Id (contract ROUTES)
const NO_AUTH_PATHS = ["/health", "/evals/report.json"];
app.use((req: Request, res: Response, next: NextFunction) => {
  if (NO_AUTH_PATHS.includes(req.path)) return next();
  const userId = req.headers["x-user-id"];
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    return res.status(401).json({ error: "X-User-Id header required" });
  }
  next();
});

// ── Rate limiting ────────────────────────────────────────────
// 100 requests per minute per user
const limiter = rateLimit({
  windowMs: 60_000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded" },
  keyGenerator: (req) => 
    (req.headers["x-user-id"] as string) ?? req.ip ?? "unknown",
});
app.use("/threads", limiter);

// ── Zod validation ───────────────────────────────────────────
// Validate request bodies before forwarding to agent
function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Only validate POST with a body
    if (req.method !== "POST") return next();
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ 
        error: "Invalid request", 
        details: result.error.flatten() 
      });
    }
    req.body = result.data;
    next();
  };
}

// Parse JSON bodies before validation
app.use(express.json());

// Apply validation to specific routes
app.use("/threads/:id/ask",  validate(AskBody));
app.use("/artifacts",        validate(CreateArtifactBody));

// ── SSE: disable buffering on streaming route ─────────────────
// This is critical — without this, words arrive all at once
app.use("/threads/:id/ask", (req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control",     "no-cache");
  // Remove compression — it forces buffering
  delete req.headers["accept-encoding"];
  next();
});

// ── Proxy everything to agent service ────────────────────────
const AGENT_URL = process.env.AGENT_URL ?? "http://localhost:8000";

app.use(
  "/",
  createProxyMiddleware({
    target:       AGENT_URL,
    changeOrigin: true,
    on: {
      // express.json() upstream already drained the body — re-serialize req.body
      // onto the proxied request or the agent receives nothing (CLAUDE.md's
      // "don't use express.json()" note; kept, but paired with the actual fix).
      proxyReq: fixRequestBody,
      error: (err, req, res) => {
        console.error("[gateway] proxy error:", err.message);
        if (!(res as Response).headersSent) {
          (res as Response).status(502).json({ 
            error: "Agent service unavailable" 
          });
        }
      },
    },
  })
);

// ── Start ─────────────────────────────────────────────────────
const PORT = parseInt(process.env.GATEWAY_PORT ?? "8787");
app.listen(PORT, () => {
  console.log(`[gateway] listening on :${PORT}`);
});