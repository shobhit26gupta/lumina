import OpenAI from "openai";
import { Response } from "express";
import { col } from "./db.js";
import { genId, calcCost, nowIso } from "./utils.js";
import {
  webSearch,
  fetchPage,
  recallMemory,
  saveMemory,
  searchDocuments,
} from "./tools/index.js";
import { RunLog, Source } from "@lumina/contract";

// The 5 tools this loop actually calls. `plan_research` (deep search) exists in the
// contract's ToolName but isn't implemented here — deep requests are rejected upstream.
type OurTool = "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

// OpenRouter client
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const MODEL         = process.env.LLM_MODEL ?? "openai/gpt-4o-mini";
const MAX_TOOL_CALLS = 8;   // hard cap per PRD
const MAX_MS        = 90_000; // 90 second wall clock limit

// ── SSE helper ───────────────────────────────────────────────
// Writes one SSE event to the browser
function sse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  (res as any).flush?.(); // flush immediately — no buffering!
}

// ── System prompt ────────────────────────────────────────────
function buildSystemPrompt(memorySummary: string): string {
  return `You are LUMINA, a research assistant that gives grounded, 
cited answers from sources you actually retrieved.

${memorySummary ? `User preferences:\n${memorySummary}\n` : ""}

RULES:
- Always call recall_memory first to personalize your answer
- Use web_search then fetch_page to get full content
- Every claim MUST have an inline citation like [1], [2]
- Citation numbers restart at [1] every turn and refer ONLY to the sources retrieved THIS
  turn. Earlier turns in this conversation used their own [1], [2]... — those numbers are
  not valid here, even if you see them in the chat history. Never reuse a citation number
  from an earlier answer.
- Never fabricate sources or cite URLs you didn't fetch
- If you find nothing, say so honestly
- Maximum ${MAX_TOOL_CALLS} tool calls total

ANSWER FORMAT:
- Be concise and factual
- Use [n] inline citations for every claim
- If retrieval was empty, say you couldn't find information`.trim();
}

// ── Tool definitions (what the LLM can call) ─────────────────
function buildTools(useWeb: boolean, useDocs: boolean) {
  const tools: OpenAI.Chat.ChatCompletionTool[] = [];

  tools.push({
    type: "function",
    function: {
      name: "recall_memory",
      description: "Get the user's saved preferences. Always call this first.",
      parameters: {
        type: "object",
        properties: { 
          query: { type: "string" } 
        },
        required: ["query"],
      },
    },
  });

  if (useWeb) {
    tools.push({
      type: "function",
      function: {
        name: "web_search",
        description: "Search the internet for current information.",
        parameters: {
          type: "object",
          properties: { 
            query: { type: "string" } 
          },
          required: ["query"],
        },
      },
    });

    tools.push({
      type: "function",
      function: {
        name: "fetch_page",
        description: "Read the full text of a webpage. Use after web_search.",
        parameters: {
          type: "object",
          properties: { 
            url: { type: "string" } 
          },
          required: ["url"],
        },
      },
    });
  }

  if (useDocs) {
    tools.push({
      type: "function",
      function: {
        name: "search_documents",
        description: "Search the user's uploaded documents.",
        parameters: {
          type: "object",
          properties: {
            query:   { type: "string" },
            spaceId: { type: "string" },
          },
          required: ["query"],
        },
      },
    });
  }

  tools.push({
    type: "function",
    function: {
      name: "save_memory",
      description: "Save a stable user preference for future sessions.",
      parameters: {
        type: "object",
        properties: { 
          text: { type: "string" } 
        },
        required: ["text"],
      },
    },
  });

  return tools;
}

// ── Main agent loop ──────────────────────────────────────────
export async function runAgentLoop(opts: {
  requestId: string;
  threadId:  string;
  userId:    string;
  query:     string;
  mode:      "auto" | "web" | "docs";
  spaceId?:  string;
  res:       Response;
}): Promise<void> {
  const { requestId, threadId, userId, query, mode, spaceId, res } = opts;
  const startMs = Date.now();

  // Decide which tools to offer
  const useWeb  = mode !== "docs";
  const useDocs = mode !== "web" && !!spaceId;

  // Tracking state
  const sources: Source[] = [];
  const toolCallLog: RunLog["toolCalls"] = [];
  let totalIn      = 0;
  let totalOut     = 0;
  let searchCached = true;
  let ttftMs       = 0;
  let step         = 0;
  let terminated: "done" | "cap" | "error" = "done";

  // Load thread history
  const history = await col.messages()
    .find({ threadId })
    .sort({ createdAt: 1 })
    .toArray();

  // Recall memories first (before building messages)
  const memResult = await recallMemory(userId, query);
  const memorySummary = memResult.ok && memResult.data?.length
    ? memResult.data.map((m: any) => `- ${m.text}`).join("\n")
    : "";

  // Build message history for LLM
  // Strip [n] markers from prior turns — each turn's citation numbers restart at 1, so an
  // old turn's [3] left in the raw history text is not a valid reference in this turn and
  // only invites the model to cite a number that doesn't exist in this turn's sources.
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(memorySummary) },
    ...history.map((m: any) => ({
      role:    m.role as "user" | "assistant",
      content: m.role === "assistant"
        ? String(m.content).replace(/\[\d+\]/g, "")
        : m.content,
    })),
    { role: "user", content: query },
  ];

  const tools = buildTools(useWeb, useDocs);
  let loopCount = 0;

  // ── ReAct loop ─────────────────────────────────────────────
  while (true) {
    // Check caps
    if (loopCount >= MAX_TOOL_CALLS || Date.now() - startMs > MAX_MS) {
      terminated = "cap";
      break;
    }

    // Call the LLM
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    });

    const choice = completion.choices[0];
    totalIn  += completion.usage?.prompt_tokens     ?? 0;
    totalOut += completion.usage?.completion_tokens ?? 0;

    // ── LLM decided to answer (no more tool calls) ──────────
    if (choice.finish_reason === "stop") {
      const content = choice.message.content ?? "";

      // Record TTFT
      if (!ttftMs) ttftMs = Date.now() - startMs;

      // Send sources BEFORE first token (contract requirement!)
      sse(res, "sources", sources);

      // Stream answer word by word
      for (const word of content.split(/(\s+)/)) {
        sse(res, "token", { text: word });
      }

      // Save assistant message to DB
      const answerId = genId("ans");
      await col.messages().insertOne({
        _id:        genId("msg"),
        threadId,
        role:       "assistant",
        content,
        sources,
        answerId,
        artifactIds: [],
        createdAt:  new Date(),
      });

      // Send done event
      const latencyMs = Date.now() - startMs;
      const costUsd   = calcCost(MODEL, totalIn, totalOut);
      sse(res, "done", {
        answerId,
        latencyMs,
        ttftMs,
        model: MODEL,
        tokens:       { in: totalIn, out: totalOut },
        costUsd,
        searchCached,
        terminated,
        depth: "quick",
      });

      // Save run log
      await saveRunLog(requestId, {
        requestId,
        tokens:       totalIn + totalOut,
        wallClockSec: latencyMs / 1000,
        costUsd,
        terminated,
        depth:        "quick",
        toolCalls:    toolCallLog,
        createdAt:    nowIso(),
      });

      break;
    }

    // ── LLM wants to call tools ──────────────────────────────
    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls) {
      messages.push(choice.message);

      for (const tc of choice.message.tool_calls) {
        loopCount++;
        const name    = tc.function.name;
        const args    = JSON.parse(tc.function.arguments);
        const toolStart = Date.now();

        // Record TTFT on first tool call
        if (!ttftMs) ttftMs = Date.now() - startMs;

        let result: any;
        let ok = true;
        let errStr: string | undefined;

        // Call the actual tool
        try {
          result = await dispatchTool(
            name, args, userId, spaceId, threadId
          );
          ok = result.ok;
          if (!ok) errStr = result.error;

          // Track sources from search results
          if (ok && name === "web_search" && result.data) {
            if (!result.cached) searchCached = false;
            for (const r of result.data) {
              sources.push({
                n:       sources.length + 1,
                kind:    "web",
                title:   r.title,
                url:     r.url,
                snippet: r.snippet?.slice(0, 300) ?? "",
              });
            }
          }

          if (ok && name === "search_documents" && result.data?.chunks) {
            searchCached = false;
            for (const chunk of result.data.chunks) {
              sources.push({
                n:       sources.length + 1,
                kind:    "doc",
                title:   chunk.docId,
                docId:   chunk.docId,
                locator: chunk.locator,
                snippet: chunk.text?.slice(0, 300) ?? "",
              });
            }
          }
        } catch (e: any) {
          ok     = false;
          errStr = e.message;
          result = { ok: false };
        }

        const ms = Date.now() - toolStart;
        toolCallLog.push({ name: name as OurTool, ok, ms, ...(errStr ? { error: errStr } : {}) });

        // Send trace event so browser shows "searching..."
        sse(res, "trace", {
          step: ++step,
          tool: name,
          input: args,
          ok,
          ms,
          ...(errStr ? { error: errStr } : {}),
        });

        // Feed result back to LLM
        messages.push({
          role:        "tool",
          tool_call_id: tc.id,
          content:     ok
            ? JSON.stringify(result.data)
            : JSON.stringify({ error: errStr }),
        });
      }
    }
  }

  // ── Handle cap/timeout ────────────────────────────────────
  if (terminated === "cap") {
    sse(res, "sources", sources);
    sse(res, "token",   { text: "(Answer truncated — tool call limit reached)" });
    const latencyMs = Date.now() - startMs;
    const costUsd   = calcCost(MODEL, totalIn, totalOut);
    sse(res, "done", {
      answerId:     genId("ans"),
      latencyMs,
      ttftMs:       ttftMs || latencyMs,
      model:        MODEL,
      tokens:       { in: totalIn, out: totalOut },
      costUsd,
      searchCached,
      terminated:   "cap",
      depth:        "quick",
    });
    await saveRunLog(requestId, {
      requestId,
      tokens:       totalIn + totalOut,
      wallClockSec: latencyMs / 1000,
      costUsd,
      terminated:   "cap",
      depth:        "quick",
      toolCalls:    toolCallLog,
      createdAt:    nowIso(),
    });
  }
}

// ── Tool dispatcher ──────────────────────────────────────────
async function dispatchTool(
  name:      string,
  args:      any,
  userId:    string,
  spaceId:   string | undefined,
  threadId:  string,
) {
  switch (name) {
    case "web_search":
      return webSearch(args.query);
    case "fetch_page":
      return fetchPage(args.url);
    case "search_documents":
      return searchDocuments(args.query, args.spaceId ?? spaceId ?? "");
    case "recall_memory":
      return recallMemory(userId, args.query);
    case "save_memory":
      return saveMemory(userId, args.text, threadId);
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

// ── Run log writer ────────────────────────────────────────────
// runs/<requestId>.json — RunLog plus the requestId/createdAt fields that make the
// file self-identifying (RunDoc's shape, minus the fields Mongo assigns on insert).
async function saveRunLog(requestId: string, log: RunLog & { requestId: string; createdAt: string }) {
  await mkdir("runs", { recursive: true });
  await writeFile(
    join("runs", `${requestId}.json`),
    JSON.stringify(log, null, 2)
  );
  // Also save to MongoDB
  await col.runs()
    .insertOne({ ...log, _id: requestId as any })
    .catch(() => {}); // don't crash if DB is down
}