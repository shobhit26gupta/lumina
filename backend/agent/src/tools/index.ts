import { col } from "../db.js";
import { genId } from "../utils.js";
import { getCachedSearch, setCachedSearch } from "../searchCache.js";
import OpenAI from "openai";

// OpenRouter client
const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// Every tool returns this shape
export interface ToolResult {
  ok:      boolean;
  data?:   any;
  error?:  string;
  cached?: boolean;
}

// ── Tool 1: web_search ───────────────────────────────────────
export async function webSearch(query: string): Promise<ToolResult> {
  const provider = process.env.SEARCH_PROVIDER ?? "tavily";

  const cached = await getCachedSearch(query, provider);
  if (cached) return { ok: true, data: cached, cached: true };

  try {
    let results: any[];
    if (provider === "tavily") {
      results = await tavilySearch(query);
    } else {
      results = await serpApiSearch(query);
    }
    await setCachedSearch(query, provider, results);
    return { ok: true, data: results, cached: false };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

async function tavilySearch(query: string): Promise<any[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY not set");

  const res = await fetch("https://api.tavily.com/search", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key:      key,
      query,
      search_depth: "advanced",
      max_results:  5,
    }),
  });

  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data: any = await res.json();
  return (data.results ?? []).map((r: any) => ({
    title:   r.title,
    url:     r.url,
    snippet: r.content,
  }));
}

async function serpApiSearch(query: string): Promise<any[]> {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error("SERPAPI_KEY not set");

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${key}&num=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpApi ${res.status}`);
  const data: any = await res.json();
  return (data.organic_results ?? []).map((r: any) => ({
    title:   r.title,
    url:     r.link,
    snippet: r.snippet,
  }));
}

// ── Tool 2: fetch_page ───────────────────────────────────────
export async function fetchPage(url: string): Promise<ToolResult> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "LUMINA/1.0 (research bot)" },
      signal:  AbortSignal.timeout(10000),
    });

    if (!res.ok) return { ok: false, error: `${res.status} from ${url}` };

    const html = await res.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,  "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g,     " ")
      .trim()
      .slice(0, 8000);

    return { ok: true, data: { url, text } };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ── Tool 3: recall_memory ────────────────────────────────────
export async function recallMemory(
  userId: string,
  query:  string
): Promise<ToolResult> {
  try {
    const memories = await col.memories()
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();

    return {
      ok:   true,
      data: memories.map((m: any) => ({
        id:   m._id,
        text: m.text,
      })),
    };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ── Tool 4: save_memory ──────────────────────────────────────
export async function saveMemory(
  userId:       string,
  text:         string,
  sourceThread: string
): Promise<ToolResult> {
  try {
    const id = genId("mem");
    await col.memories().insertOne({
      _id:          id,
      userId,
      text,
      sourceThread,
      createdAt:    new Date(),
    });
    return { ok: true, data: { id } };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ── Tool 5: search_documents (RAG) ───────────────────────────
export async function searchDocuments(
  query:   string,
  spaceId: string
): Promise<ToolResult> {
  try {
    if (!spaceId) {
      return { ok: true, data: { chunks: [], empty: true } };
    }

    // Embed the query using same model as indexing
    const embedRes = await openai.embeddings.create({
      model: "baai/bge-m3",
      input: query,
    });
    const queryVec = embedRes.data[0].embedding;

    // Load all chunks for this space
    // (mongo-cosine-scan mode — no Atlas Vector Search needed)
    const allChunks = await col.chunks()
      .find({ spaceId })
      .toArray();

    if (!allChunks.length) {
      return { ok: true, data: { chunks: [], empty: true } };
    }

    // Score every chunk by cosine similarity
    const scored = allChunks
      .map((c: any) => ({
        ...c,
        score: cosineSim(queryVec, c.embedding),
      }))
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 5); // return top 5

    return {
      ok:   true,
      data: {
        chunks: scored.map((c: any) => ({
          docId:   c.docId,
          text:    c.text,
          locator: c.locator, // page number lives here
          score:   c.score,
        })),
      },
    };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ── Cosine similarity helper ──────────────────────────────────
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}