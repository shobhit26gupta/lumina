import { randomBytes } from "crypto";

// Generate unique IDs with prefixes
// e.g. genId("thr") → "thr_a1b2c3d4e5f6g7h8"
export function genId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

// Calculate cost based on tokens used
const RATES: Record<string, { in: number; out: number }> = {
  "openai/gpt-4o-mini": { in: 0.00015 / 1000, out: 0.0006 / 1000 },
  "openai/gpt-4o":      { in: 0.005 / 1000,   out: 0.015 / 1000  },
  "anthropic/claude-haiku-4-5-20251001": { in: 0.00025 / 1000, out: 0.00125 / 1000 },
};

export function calcCost(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const rate = RATES[model] ?? RATES["openai/gpt-4o-mini"];
  return tokensIn * rate.in + tokensOut * rate.out;
}

export function nowIso(): string {
  return new Date().toISOString();
}