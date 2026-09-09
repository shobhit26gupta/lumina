import { MongoClient, Db, GridFSBucket } from "mongodb";

let client: MongoClient;
let db: Db;

export async function connectDB(): Promise<Db> {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  client = new MongoClient(uri);
  await client.connect();
  db = client.db("lumina");
  console.log("[db] connected to MongoDB");
  return db;
}

export function getDB(): Db {
  if (!db) throw new Error("DB not connected. Call connectDB() first.");
  return db;
}

// GridFS buckets (for storing files)
let gridUploads: GridFSBucket;
let gridFiles: GridFSBucket;

export function getGridUploads(): GridFSBucket {
  if (!gridUploads) gridUploads = new GridFSBucket(getDB(), { bucketName: "uploads" });
  return gridUploads;
}

export function getGridFiles(): GridFSBucket {
  if (!gridFiles) gridFiles = new GridFSBucket(getDB(), { bucketName: "files" });
  return gridFiles;
}

// All collection accessors in one place
export const col = {
  threads:     () => getDB().collection("threads"),
  messages:    () => getDB().collection("messages"),
  memories:    () => getDB().collection("memories"),
  spaces:      () => getDB().collection("spaces"),
  documents:   () => getDB().collection("documents"),
  chunks:      () => getDB().collection("chunks"),
  searchCache: () => getDB().collection("searchCache"),
  jobs:        () => getDB().collection("jobs"),
  artifacts:   () => getDB().collection("artifacts"),
  requests:    () => getDB().collection("requests"),
  runs:        () => getDB().collection("runs"),
};