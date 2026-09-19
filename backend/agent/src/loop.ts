import OpenAI from "openai";
import { Response } from "express";
import { col } from "./db.js";
import { genId, calcCost } from "./utils.js";
import {
  webSearch,
  fetchPage,
  recallMemory,
  saveMemory,
  searchDocuments,
} from "./tools/index.js";
import { RunLog, Source, SubQuestion, ToolName } from "@lumina/contract";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

// OpenRouter client
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const MODEL         = process.env.LLM_MODEL ?? "openai/gpt-4o-mini";

// Quick: cheap and fast by default (PRD budget). Deep: several times the envelope, capped
// well inside expectations.json's wide budget (maxToolCalls 24, maxWallClockSec 240).
const MAX_TOOL_CALLS_QUICK = 8;
const MAX_MS_QUICK         = 90_000;
const MAX_TOOL_CALLS_DEEP  = 20;
const MAX_MS_DEEP          = 200_000;
const MIN_SUB_QUESTIONS    = 3;
const MAX_SUB_QUESTIONS    = 6;

// ── SSE helper ───────────────────────────────────────────────
// Writes one SSE event to the browser
function sse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  (res as any).flush?.(); // flush immediately — no buffering!
}

// ── System prompt ────────────────────────────────────────────
function buildSystemPrompt(memorySummary: string, depth: "quick" | "deep", useDocs: boolean): string {
  const routingRule = useDocs
    ? `- The user has a Space with uploaded documents available (search_documents). Try
  search_documents FIRST for this question. Only use web_search if the documents come back
  empty or clearly don't cover what's being asked — don't default to the web just because
  it's the more familiar tool.`
    : `- Use web_search then fetch_page to get full content`;

  const deepRules = `
- This is a DEEP search. Call plan_research FIRST, before any other tool — decompose the
  question into ${MIN_SUB_QUESTIONS}-${MAX_SUB_QUESTIONS} focused sub-questions that together cover it. No search
  tool will run until you do.
- After planning, tag every web_search / fetch_page / search_documents call with the
  "subQuestion" number (1-based, from your plan) it serves.
- Your final answer must address every sub-question and cite sources across all of them —
  citation numbers are one continuous list for the whole answer, not per sub-question.
- Deep search costs several times a quick search. Make the sub-questions earn that: each
  one should surface something a single quick search would have missed.`;

  return `You are LUMINA, a research assistant that gives grounded,
cited answers from sources you actually retrieved.

${memorySummary ? `User preferences:\n${memorySummary}\n` : ""}

RULES:
- Always call recall_memory first to personalize your answer
${routingRule}
- Every claim MUST have an inline citation like [1], [2]
- Citation numbers restart at [1] every turn and refer ONLY to the sources retrieved THIS
  turn. Earlier turns in this conversation used their own [1], [2]... — those numbers are
  not valid here, even if you see them in the chat history. Never reuse a citation number
  from an earlier answer.
- Never fabricate sources or cite URLs you didn't fetch
- If you find nothing, say so honestly
- Maximum ${depth === "deep" ? MAX_TOOL_CALLS_DEEP : MAX_TOOL_CALLS_QUICK} tool calls total
${depth === "deep" ? deepRules : ""}

ANSWER FORMAT:
- Be concise and factual
- Use [n] inline citations for every claim
- If retrieval was empty, say you couldn't find information`.trim();
}

// ── Tool definitions (what the LLM can call) ─────────────────
function buildTools(useWeb: boolean, useDocs: boolean, depth: "quick" | "deep") {
  const tools: OpenAI.Chat.ChatCompletionTool[] = [];
  const deep = depth === "deep";

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

  // DEEP SEARCH ONLY — never offered to a quick search, so a quick run can never call it
  // (rule R2: depth is opted into, never drifted into).
  if (deep) {
    tools.push({
      type: "function",
      function: {
        name: "plan_research",
        description:
          `Decompose the question into ${MIN_SUB_QUESTIONS}-${MAX_SUB_QUESTIONS} sub-questions. ` +
          "Call this FIRST, before any search — no other tool runs until you do.",
        parameters: {
          type: "object",
          properties: {
            subQuestions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  question: { type: "string" },
                  reason:   { type: "string", description: "why this sub-question matters" },
                },
                required: ["question"],
              },
            },
            reason: { type: "string", description: "the plan overall, in one line" },
          },
          required: ["subQuestions"],
        },
      },
    });
  }

  if (useWeb) {
    tools.push({
      type: "function",
      function: {
        name: "web_search",
        description: "Search the internet for current information.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            ...(deep ? { subQuestion: { type: "number", description: "which sub-question (1-based) this serves" } } : {}),
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
            url: { type: "string" },
            ...(deep ? { subQuestion: { type: "number", description: "which sub-question (1-based) this serves" } } : {}),
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
        description: "Search the user's uploaded documents in the current Space.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            // No spaceId param — the model doesn't know it and shouldn't guess; the
            // dispatcher always scopes this to the Space the request actually selected.
            ...(deep ? { subQuestion: { type: "number", description: "which sub-question (1-based) this serves" } } : {}),
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
  depth:     "quick" | "deep";
  spaceId?:  string;
  res:       Response;
}): Promise<void> {
  const { requestId, threadId, userId, query, mode, depth, spaceId, res } = opts;
  const startMs = Date.now();

  // Decide which tools to offer
  const useWeb  = mode !== "docs";
  const useDocs = mode !== "web" && !!spaceId;
  const maxToolCalls = depth === "deep" ? MAX_TOOL_CALLS_DEEP : MAX_TOOL_CALLS_QUICK;
  const maxMs        = depth === "deep" ? MAX_MS_DEEP        : MAX_MS_QUICK;

  // Tracking state
  const sources: Source[] = [];
  const toolCallLog: RunLog["toolCalls"] = [];
  let totalIn      = 0;
  let totalOut     = 0;
  let searchCached = true;
  let ttftMs       = 0;
  let step         = 0;
  let terminated: "done" | "cap" | "error" = "done";
  let planSubQuestions: SubQuestion[] | undefined; // set once plan_research runs (deep only)

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
    { role: "system", content: buildSystemPrompt(memorySummary, depth, useDocs) },
    ...history.map((m: any) => ({
      role:    m.role as "user" | "assistant",
      content: m.role === "assistant"
        ? String(m.content).replace(/\[\d+\]/g, "")
        : m.content,
    })),
    { role: "user", content: query },
  ];

  const tools = buildTools(useWeb, useDocs, depth);
  let loopCount = 0;

  // ── ReAct loop ─────────────────────────────────────────────
  while (true) {
    // Check caps
    if (loopCount >= maxToolCalls || Date.now() - startMs > maxMs) {
      terminated = "cap";
      break;
    }

    // Call the LLM — streamed, so the answer's actual tokens reach the browser as the
    // model generates them instead of appearing all at once after a silent wait.
    const stream = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
    });

    let content = "";
    let sourcesSent = false;
    let finishReason: string | null = null;
    const toolCallAcc: Record<number, { id: string; name: string; args: string }> = {};

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;

      if (delta?.content) {
        // Sources must arrive before the first token (contract requirement) — the first
        // content delta IS the first token, so this is the last possible moment.
        if (!sourcesSent) {
          sse(res, "sources", sources);
          sourcesSent = true;
        }
        if (!ttftMs) ttftMs = Date.now() - startMs;
        content += delta.content;
        sse(res, "token", { text: delta.content });
      }

      if (delta?.tool_calls) {
        if (!ttftMs) ttftMs = Date.now() - startMs;
        for (const tc of delta.tool_calls) {
          const acc = (toolCallAcc[tc.index] ??= { id: "", name: "", args: "" });
          if (tc.id)              acc.id   = tc.id;
          if (tc.function?.name)  acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }

      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      if (chunk.usage) {
        totalIn  += chunk.usage.prompt_tokens     ?? 0;
        totalOut += chunk.usage.completion_tokens ?? 0;
      }
    }

    const toolCalls = Object.values(toolCallAcc).map((t) => ({
      id: t.id,
      type: "function" as const,
      function: { name: t.name, arguments: t.args },
    }));

    // ── LLM decided to answer (no more tool calls) ──────────
    if (finishReason === "stop") {
      // An empty answer never triggered a content delta above — sources still have to
      // arrive before `done` even when there's nothing to cite them in.
      if (!sourcesSent) sse(res, "sources", sources);
      if (!ttftMs) ttftMs = Date.now() - startMs;

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
        depth,
        ...(planSubQuestions ? { subQuestions: planSubQuestions.length } : {}),
      });

      // Save run log
      await saveRunLog(requestId, {
        requestId,
        userId,
        threadId,
        query,
        tokens:       totalIn + totalOut,
        wallClockSec: latencyMs / 1000,
        costUsd,
        terminated,
        depth,
        toolCalls:    toolCallLog,
        createdAt:    new Date(),
      });

      break;
    }

    // ── LLM wants to call tools ──────────────────────────────
    if (finishReason === "tool_calls" && toolCalls.length) {
      messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls });

      for (const tc of toolCalls) {
        loopCount++;
        const name    = tc.function.name;
        const args    = JSON.parse(tc.function.arguments);
        const toolStart = Date.now();

        // Record TTFT on first tool call
        if (!ttftMs) ttftMs = Date.now() - startMs;

        let result: any;
        let ok = true;
        let errStr: string | undefined;

        // Deep search must plan before it retrieves anything (PlanEvent's whole point).
        // A search tool called before plan_research gets refused, not silently allowed.
        if (depth === "deep" && name !== "plan_research" && name !== "recall_memory" && !planSubQuestions) {
          const ms = Date.now() - toolStart;
          toolCallLog.push({ name: name as ToolName, ok: false, ms, error: "called before plan_research" });
          sse(res, "trace", { step: ++step, tool: name, input: args, ok: false, ms, error: "call plan_research first" });
          messages.push({
            role: "tool", tool_call_id: tc.id,
            content: JSON.stringify({ error: "call plan_research first, before any search tool" }),
          });
          continue;
        }

        // ── plan_research: DEEP SEARCH ONLY. Emits `plan`, not `trace` — the contract's
        // event order is plan → trace* → sources* → token* → done, so the plan is its own
        // event, arriving before any retrieval trace.
        if (name === "plan_research") {
          const raw: Array<{ question: string; reason?: string }> = Array.isArray(args.subQuestions) ? args.subQuestions : [];
          planSubQuestions = raw.slice(0, MAX_SUB_QUESTIONS).map((sq, i) => ({
            i: i + 1,
            question: sq.question,
            ...(sq.reason ? { reason: sq.reason } : {}),
          }));
          ok = planSubQuestions.length >= 2; // contract floor; system prompt asks for MIN_SUB_QUESTIONS
          if (!ok) errStr = `plan_research returned ${planSubQuestions.length} sub-question(s), need at least 2`;

          toolCallLog.push({ name: "plan_research", ok, ms: Date.now() - toolStart, ...(errStr ? { error: errStr } : {}) });
          if (ok) {
            sse(res, "plan", { subQuestions: planSubQuestions, ...(args.reason ? { reason: args.reason } : {}) });
          }
          messages.push({
            role: "tool", tool_call_id: tc.id,
            content: ok
              ? JSON.stringify({ accepted: planSubQuestions.length, subQuestions: planSubQuestions })
              : JSON.stringify({ error: errStr }),
          });
          continue;
        }

        // Call the actual tool
        try {
          result = await dispatchTool(
            name, args, userId, spaceId, threadId
          );
          ok = result.ok;
          if (!ok) errStr = result.error;

          const subQuestion: number | undefined =
            depth === "deep" && typeof args.subQuestion === "number" ? args.subQuestion : undefined;

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
                ...(subQuestion ? { subQuestion } : {}),
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
                ...(subQuestion ? { subQuestion } : {}),
              });
            }
          }
        } catch (e: any) {
          ok     = false;
          errStr = e.message;
          result = { ok: false };
        }

        const ms = Date.now() - toolStart;
        const traceSubQuestion: number | undefined =
          depth === "deep" && typeof args.subQuestion === "number" ? args.subQuestion : undefined;
        toolCallLog.push({ name: name as ToolName, ok, ms, ...(errStr ? { error: errStr } : {}) });

        // Send trace event so browser shows "searching..."
        sse(res, "trace", {
          step: ++step,
          tool: name,
          input: args,
          ok,
          ms,
          ...(errStr ? { error: errStr } : {}),
          ...(traceSubQuestion ? { subQuestion: traceSubQuestion } : {}),
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
      depth,
      ...(planSubQuestions ? { subQuestions: planSubQuestions.length } : {}),
    });
    await saveRunLog(requestId, {
      requestId,
      userId,
      threadId,
      query,
      tokens:       totalIn + totalOut,
      wallClockSec: latencyMs / 1000,
      costUsd,
      terminated:   "cap",
      depth,
      toolCalls:    toolCallLog,
      createdAt:    new Date(),
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
      // Always the request's own Space — never the model's guess (see buildTools).
      return searchDocuments(args.query, spaceId ?? "");
    case "recall_memory":
      return recallMemory(userId, args.query);
    case "save_memory":
      return saveMemory(userId, args.text, threadId);
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

// ── Run log writer ────────────────────────────────────────────
// runs/<requestId>.json — RunLog plus the RunDoc fields (minus what Mongo assigns on
// insert) that let a run be found later: by requestId for build-report.mjs's
// --successful/--failing, by userId for the deep-search daily cap count.
async function saveRunLog(
  requestId: string,
  log: RunLog & { requestId: string; userId: string; threadId: string; query: string; createdAt: Date }
) {
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