// Embeddings for semantic memory search.
//
// 2026-05-23 swap: was Gemini (`gemini-embedding-001`), which kept returning
// 403 PERMISSION_DENIED on Gabe's Google project. Now uses the already-
// installed local `bge-m3:latest` model via Ollama. BGE-M3 outputs 1024-dim
// vectors and is the canonical multilingual embedding model for retrieval.
//
// Local embeddings are the right call here per the intelligence + efficiency
// principle: bge-m3 is best-in-class for the embedding task at its size,
// runs locally with no auth dependency, never hits a rate limit, and keeps
// memory-content vectors on-machine.
//
// Cloud-tier upgrade path (later, if needed): Voyage AI's voyage-3 is the
// current best-in-class embedding model and outperforms bge-m3 noticeably
// for English. Swap by adding a Voyage client + flipping EMBEDDING_BACKEND.

import { ollamaEmbed } from './ollama.js';
import { logger } from './logger.js';

const EMBEDDING_MODEL = 'bge-m3:latest';

/**
 * bge-m3 on Ollama 0.24 sometimes returns NaN values for inputs containing
 * specific patterns (observed: hyphenated identifiers immediately followed
 * by file extensions, e.g. "claw-runner.ts"). The JSON encoder then bails
 * with HTTP 500 "unsupported value: NaN". Strip the troublesome pattern
 * by replacing non-alphanumeric runs with single spaces — semantic
 * content is preserved, the tokenizer just sees a slightly different
 * shape. Reserved for the retry path; we still try the original input
 * first so semantic search benefits when bge-m3 cooperates.
 */
function sanitizeForEmbedding(text: string): string {
  return text
    .replace(/[^A-Za-z0-9\s]/g, ' ')   // strip punctuation, paths, code-y characters
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim();
}

/**
 * Generate an embedding vector for a text string. Returns a float array
 * (1024 dimensions for bge-m3). Returns an empty array on failure so
 * callers can fall back gracefully — never throws.
 *
 * Retry strategy: if the first call fails with the known NaN error from
 * bge-m3, retry once with sanitized input. The vast majority of bge-m3
 * failures observed in this codebase are triggered by code-shaped tokens
 * (`claw-runner.ts`, `foo_bar.py`, etc.); stripping non-alphanum to spaces
 * fixes them. If even the sanitized retry fails, return [] and let the
 * caller's fallback (importance+recency-only ranking) handle the rest.
 */
export async function embedText(text: string): Promise<number[]> {
  if (!text || !text.trim()) return [];
  try {
    return await ollamaEmbed(EMBEDDING_MODEL, text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Retry only when the failure looks like the known NaN bug.
    if (msg.includes('NaN') || msg.includes('unsupported value')) {
      const sanitized = sanitizeForEmbedding(text);
      if (sanitized && sanitized !== text) {
        try {
          return await ollamaEmbed(EMBEDDING_MODEL, sanitized);
        } catch (err2) {
          logger.warn(
            { err: err2 instanceof Error ? err2.message : String(err2), model: EMBEDDING_MODEL, retried: true },
            'Local embedding failed even after sanitization; returning empty vector',
          );
          return [];
        }
      }
    }
    logger.warn(
      { err: msg, model: EMBEDDING_MODEL },
      'Local embedding failed; returning empty vector',
    );
    return [];
  }
}

/**
 * Cosine similarity between two vectors. Returns -1 to 1.
 * Returns 0 for mismatched-length or empty vectors so callers can treat
 * "couldn't compute" as "no signal."
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}
