import { col, getGridUploads } from "../db.js";
import { genId } from "../utils.js";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey:   process.env.OPENROUTER_API_KEY,
  baseURL:  "https://openrouter.ai/api/v1",
});

const CHUNK_SIZE    = 800;  // characters per chunk
const CHUNK_OVERLAP = 100;  // overlap between chunks

interface IndexDocPayload {
  docId:    string;
  spaceId:  string;
  fileId:   string;
  mimetype: string;
}

export async function indexDocument(payload: IndexDocPayload) {
  const { docId, spaceId, fileId } = payload;

  // Update status → parsing
  await col.documents().updateOne(
    { _id: docId },
    { $set: { status: "parsing", pct: 5 } }
  );

  // Load file from GridFS
  const bucket = getGridUploads();
  const chunks: Buffer[] = [];
  const stream = bucket.openDownloadStream(fileId as any);

  await new Promise<void>((resolve, reject) => {
    stream.on("data",  (d: Buffer) => chunks.push(d));
    stream.on("end",   resolve);
    stream.on("error", reject);
  });

  const fileBuffer = Buffer.concat(chunks);

  // Parse text from PDF or plain text
  let pages: Array<{ page: number; text: string }> = [];

  if (payload.mimetype === "application/pdf") {
    pages = await parsePdf(fileBuffer);
  } else {
    // Plain text or markdown
    pages = [{ page: 1, text: fileBuffer.toString("utf8") }];
  }

  await col.documents().updateOne(
    { _id: docId },
    { $set: { pct: 30, pages: pages.length } }
  );

  // Chunk the pages
  const textChunks = chunkPages(pages);
  await col.documents().updateOne(
    { _id: docId },
    { $set: { status: "embedding", pct: 40 } }
  );

  // Embed in batches of 20
  const BATCH = 20;
  for (let i = 0; i < textChunks.length; i += BATCH) {
    const batch = textChunks.slice(i, i + BATCH);

    // Get embeddings from OpenRouter
    const embedRes = await openai.embeddings.create({
      model: "baai/bge-m3",
      input: batch.map((c) => c.text),
    });

    // Store chunks with embeddings
    const docs = batch.map((chunk, j) => ({
      _id:       genId("chk"),
      docId,
      spaceId,
      text:      chunk.text,
      locator:   chunk.locator,
      embedding: embedRes.data[j].embedding,
    }));

    await col.chunks().insertMany(docs);

    // Update progress
    const pct = 40 + Math.floor(
      ((i + batch.length) / textChunks.length) * 55
    );
    await col.documents().updateOne(
      { _id: docId },
      { $set: { pct } }
    );
  }

  // Mark as indexed
  await col.documents().updateOne(
    { _id: docId },
    { $set: { status: "indexed", pct: 100 } }
  );

  console.log(`[indexDocument] ${docId} indexed (${textChunks.length} chunks)`);
}

// ── PDF Parser ───────────────────────────────────────────────
async function parsePdf(
  buffer: Buffer
): Promise<Array<{ page: number; text: string }>> {
  // Dynamic import of pdfjs-dist
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data     = new Uint8Array(buffer);
  const pdf      = await pdfjsLib.getDocument({ data }).promise;
  const pages: Array<{ page: number; text: string }> = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text    = content.items
      .map((item: any) => item.str)
      .join(" ")
      .trim();
    if (text) pages.push({ page: i, text });
  }
  return pages;
}

// ── Chunker ──────────────────────────────────────────────────
function chunkPages(pages: Array<{ page: number; text: string }>) {
  const result: Array<{
    text:    string;
    locator: { page: number };
  }> = [];

  for (const { page, text } of pages) {
    // Split into sentences
    const sentences = text.match(/[^.!?\n]+[.!?\n]+/g) ?? [text];
    let current = "";

    for (const sentence of sentences) {
      if ((current + sentence).length > CHUNK_SIZE) {
        if (current.trim()) {
          result.push({ text: current.trim(), locator: { page } });
          // Keep overlap
          current = current.slice(-CHUNK_OVERLAP) + sentence;
        } else {
          current = sentence;
        }
      } else {
        current += sentence;
      }
    }
    if (current.trim()) {
      result.push({ text: current.trim(), locator: { page } });
    }
  }
  return result;
}
