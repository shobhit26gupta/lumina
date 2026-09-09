import OpenAI from "openai";
import pptxgen from "pptxgenjs";
import { col, getGridFiles } from "../db.js";
import { Readable } from "stream";

const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

interface MakeDeckPayload {
  artifactId: string;
  threadId:   string;
  answerId?:  string;
  userId:     string;
}

export async function makeDeck(payload: MakeDeckPayload) {
  const { artifactId, threadId, answerId } = payload;

  // Get the answer + sources
  const message = answerId
    ? await col.messages().findOne({ answerId })
    : await col.messages().findOne(
        { threadId, role: "assistant" },
        { sort: { createdAt: -1 } }
      );

  if (!message) throw new Error("Answer message not found");

  const sources: any[] = message.sources ?? [];
  const content: string = message.content ?? "";

  // Generate outline via LLM
  const completion = await openai.chat.completions.create({
    model: process.env.LLM_MODEL ?? "openai/gpt-4o-mini",
    messages: [{
      role: "user",
      content: `You are a presentation writer. Create a slide deck outline.

ANSWER:
${content}

SOURCES:
${sources.map((s: any) => `[${s.n}] ${s.title} — ${s.snippet}`).join("\n")}

Return ONLY valid JSON:
{
  "title": "Deck title",
  "slides": [
    {
      "heading": "Slide title",
      "bullets": ["bullet 1 [1]", "bullet 2 [2]"],
      "citations": [1, 2],
      "notes": "Speaker notes"
    }
  ]
}

Rules:
- 6 to 8 slides
- Every citation number must exist in sources above
- Last slide is always "Sources"`,
    }],
    response_format: { type: "json_object" },
    max_tokens: 2000,
  });

  const outline = JSON.parse(
    completion.choices[0].message.content ?? "{}"
  );

  // Build the .pptx file
  const pptx = new pptxgen();

  // Title slide
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: "1a1a2e" };
  titleSlide.addText(outline.title ?? "Research Summary", {
    x: 1, y: 2.5, w: 11, h: 1.5,
    fontSize: 36, bold: true,
    color: "FFFFFF", align: "center",
  });

  // Content slides
  for (const slide of (outline.slides ?? [])) {
    if (slide.heading === "Sources") continue;
    const s = pptx.addSlide();
    s.background = { color: "FFFFFF" };
    s.addText(slide.heading ?? "", {
      x: 0.5, y: 0.3, w: 12, h: 0.8,
      fontSize: 24, bold: true, color: "1a1a2e",
    });
    if (slide.bullets?.length) {
      s.addText(
        slide.bullets.map((b: string) => ({
          text:    b,
          options: { bullet: true, fontSize: 16, color: "333333" },
        })),
        { x: 0.5, y: 1.3, w: 12, h: 5.5 }
      );
    }
    if (slide.notes) s.addNotes(slide.notes);
  }

  // Sources slide
  const srcSlide = pptx.addSlide();
  srcSlide.background = { color: "f5f5f5" };
  srcSlide.addText("Sources", {
    x: 0.5, y: 0.3, w: 12, h: 0.8,
    fontSize: 24, bold: true, color: "1a1a2e",
  });
  srcSlide.addText(
    sources.map((s: any) =>
      `[${s.n}] ${s.title}${s.url ? " — " + s.url : ""}`
    ).join("\n"),
    { x: 0.5, y: 1.3, w: 12, h: 5.5, fontSize: 11, color: "444444" }
  );

  // Save to buffer then GridFS
  const buf     = await pptx.write({ outputType: "nodebuffer" }) as Buffer;
  const bucket  = getGridFiles();
  const fileId  = `${artifactId}.pptx`;
  const readable = Readable.from(buf);

  const uploadStream = bucket.openUploadStreamWithId(
    fileId as any,
    `${artifactId}.pptx`,
    { metadata: { artifactId, kind: "deck" } }
  );

  await new Promise<void>((resolve, reject) => {
    readable.pipe(uploadStream)
      .on("finish", resolve)
      .on("error",  reject);
  });

  // Update artifact record
  await col.artifacts().updateOne(
    { _id: artifactId },
    {
      $set: {
        status:    "ready",
        fileId,
        outline,
        model:     process.env.LLM_MODEL ?? "openai/gpt-4o-mini",
        costUsd:   0.001,
        updatedAt: new Date(),
      },
    }
  );
}
