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
 * Generate an embedding vector for a text string. Returns a float array
 * (1024 dimensions for bge-m3). Returns an empty array on failure so
 * callers can fall back gracefully — never throws.
 */
export async function embedText(text: string): Promise<number[]> {
  if (!text || !text.trim()) return [];
  try {
    return await ollamaEmbed(EMBEDDING_MODEL, text);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), model: EMBEDDING_MODEL },
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
