import OpenAI from "openai";
import { col, getGridFiles } from "../db.js";
import { Readable } from "stream";

const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

interface MakeImagePayload {
  artifactId: string;
  threadId:   string;
  answerId?:  string;
  prompt?:    string;
  userId:     string;
}

export async function makeImage(payload: MakeImagePayload) {
  const { artifactId, threadId, answerId } = payload;
  let { prompt } = payload;

  const dryRun = process.env.DRY_RUN === "true";

  // Generate prompt from answer if not provided
  if (!prompt) {
    const message = answerId
      ? await col.messages().findOne({ answerId })
      : await col.messages().findOne(
          { threadId, role: "assistant" },
          { sort: { createdAt: -1 } }
        );

    if (message) {
      const gen = await openai.chat.completions.create({
        model: process.env.LLM_MODEL ?? "openai/gpt-4o-mini",
        messages: [{
          role: "user",
          content: `Write a concise image generation prompt (max 50 words)
for a professional hero image based on this research answer:

${message.content?.slice(0, 500)}`,
        }],
        max_tokens: 100,
      });
      prompt = gen.choices[0].message.content?.trim()
               ?? "Abstract professional concept";
    }
  }

  let imageBuffer: Buffer;
  let model   = "openai/dall-e-3";
  let costUsd = 0.04;

  if (dryRun) {
    // 1x1 transparent PNG placeholder — no API call
    imageBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQ" +
      "AABjkB6QAAAABJRU5ErkJggg==",
      "base64"
    );
    model   = "dry-run";
    costUsd = 0;
    console.log(`[makeImage] DRY_RUN — skipping real image generation`);
  } else {
    // Real image generation
    const response = await openai.images.generate({
      model:  "dall-e-3",
      prompt: prompt ?? "Abstract professional concept",
      n:      1,
      size:   "1024x1024",
    });

    const url = response.data[0]?.url;
    if (!url) throw new Error("No image URL returned");

    const imgRes = await fetch(url);
    imageBuffer  = Buffer.from(await imgRes.arrayBuffer());
  }

  // Store in GridFS
  const bucket  = getGridFiles();
  const fileId  = `${artifactId}.png`;
  const readable = Readable.from(imageBuffer);

  const uploadStream = bucket.openUploadStreamWithId(
    fileId as any,
    `${artifactId}.png`,
    { metadata: { artifactId, kind: "image" } }
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
        status:     "ready",
        fileId,
        model,
        costUsd,
        promptUsed: prompt,
        updatedAt:  new Date(),
      },
    }
  );
}
