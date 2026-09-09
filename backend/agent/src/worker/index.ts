import { col } from "../db.js";
import { indexDocument } from "./indexDocument.js";
import { makeDeck } from "./makeDeck.js";
import { makeImage } from "./makeImage.js";
import { randomBytes } from "crypto";

const WORKER_ID = randomBytes(4).toString("hex");
const POLL_INTERVAL_MS = 2000;  // check every 2 seconds
const STALE_MS = 5 * 60 * 1000; // 5 minutes

export function startWorker() {
  console.log(`[worker:${WORKER_ID}] started`);
  poll();
}

async function poll() {
  while (true) {
    try {
      // Reclaim stale jobs (worker crashed mid-job)
      await col.jobs().updateMany(
        {
          status: "running",
          claimedAt: { $lt: new Date(Date.now() - STALE_MS) },
        },
        { $set: { status: "pending" } }
      );

      // Claim ONE job atomically
      // findOneAndUpdate is atomic — only one worker can claim a job
      const job = await col.jobs().findOneAndUpdate(
        { status: "pending", attempts: { $lt: 3 } },
        {
          $set: {
            status:    "running",
            claimedAt: new Date(),
            workerId:  WORKER_ID,
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: "after", sort: { createdAt: 1 } }
      );

      // No jobs waiting — sleep and check again
      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log(`[worker:${WORKER_ID}] running job ${job._id} (${job.kind})`);

      // Run the right handler
      try {
        switch (job.kind) {
          case "index_document":
            await indexDocument(job.payload as any);
            break;
          case "make_deck":
            await makeDeck(job.payload as any);
            break;
          case "make_image":
            await makeImage(job.payload as any);
            break;
          default:
            throw new Error(`Unknown job kind: ${job.kind}`);
        }

        // Mark done
        await col.jobs().updateOne(
          { _id: job._id },
          { $set: { status: "done" } }
        );
        console.log(`[worker:${WORKER_ID}] job ${job._id} done`);

      } catch (e: any) {
        console.error(`[worker:${WORKER_ID}] job ${job._id} failed:`, e.message);

        const exhausted = job.attempts >= 3;

        // Mark failed — will retry up to 3 attempts
        await col.jobs().updateOne(
          { _id: job._id },
          {
            $set: {
              status: exhausted ? "failed" : "pending",
              error:  e.message,
            },
          }
        );

        // Once retries are exhausted, the target row must say so too — otherwise
        // the UI polls a "parsing"/"pending" status forever with no way to tell
        // the job stopped trying.
        if (exhausted) {
          const payload = job.payload as any;
          if (job.kind === "index_document" && payload.docId) {
            await col.documents().updateOne(
              { _id: payload.docId },
              { $set: { status: "failed", error: e.message } }
            );
          } else if ((job.kind === "make_deck" || job.kind === "make_image") && payload.artifactId) {
            await col.artifacts().updateOne(
              { _id: payload.artifactId },
              { $set: { status: "failed", error: e.message } }
            );
          }
        }
      }

    } catch (e: any) {
      console.error(`[worker:${WORKER_ID}] poll error:`, e.message);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
