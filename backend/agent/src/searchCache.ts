import { createHash } from "crypto";
import { LRUCache } from "lru-cache";
import { col } from "./db.js";

// How long to cache search results (default 6 hours)
const TTL_MS = parseInt(process.env.SEARCH_CACHE_TTL_HOURS ?? "6") 
               * 3600 * 1000;

// L1: in-memory cache (fast, lost on restart)
// Like a Python dict with automatic expiry + size limit
const lru = new LRUCache<string, any>({ 
  max: 500,      // max 500 entries
  ttl: TTL_MS    // auto-expire after 6 hours
});

// Make a cache key from the query
// Same query always gets the same key
function cacheKey(query: string, provider: string): string {
  const normalized = query.toLowerCase().trim();
  return createHash("sha256")
    .update(`${normalized}|${provider}`)
    .digest("hex");
}

// Time-sensitive queries should never be cached
// "latest news today" changes every minute
function isTimeSensitive(query: string): boolean {
  return /today|latest|breaking|current|now|\b202[5-9]\b/i
    .test(query);
}

// Try to get cached results (L1 first, then L2)
export async function getCachedSearch(
  query: string, 
  provider: string
): Promise<any[] | null> {
  if (isTimeSensitive(query)) return null;
  
  const key = cacheKey(query, provider);

  // Check L1 (in-memory) first — fastest
  const l1 = lru.get(key);
  if (l1) {
    console.log(`[cache] L1 hit: ${query.slice(0, 40)}`);
    return l1;
  }

  // Check L2 (MongoDB) — survives restarts
  const doc = await col.searchCache().findOne({ 
    _id: key, 
    expiresAt: { $gt: new Date() } 
  });
  
  if (doc) {
    console.log(`[cache] L2 hit: ${query.slice(0, 40)}`);
    lru.set(key, doc.results); // warm L1 for next time
    return doc.results;
  }

  return null; // cache miss
}

// Store results in both L1 and L2
export async function setCachedSearch(
  query: string,
  provider: string,
  results: any[]
): Promise<void> {
  if (isTimeSensitive(query)) return;

  const key = cacheKey(query, provider);
  const expiresAt = new Date(Date.now() + TTL_MS);

  // Store in L1
  lru.set(key, results);

  // Store in L2 (MongoDB TTL index auto-deletes when expiresAt passes)
  await col.searchCache().replaceOne(
    { _id: key },
    { _id: key, provider, results, expiresAt, cachedAt: new Date() },
    { upsert: true }
  );
}