/**
 * src/services/retrieve.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Layer 2 (embeddings + vector search) — NOW WIRED to Qdrant.
 *
 * How it works:
 *   1. Embed the question and run a vector similarity search in Qdrant.
 *   2. Take the top N chunk_ids returned and fetch their FULL rows from Neon
 *      (Qdrant only stores a lightweight payload, not the full chunk text/
 *      heading_path/etc — Neon stays the source of truth for chunk content).
 *   3. PLUS pull in each top chunk's related_ids (cross-doc graph links) —
 *      this is the "interconnected agentic" payoff: a question that matches
 *      a topic in one doc also surfaces the same topic from another doc.
 *
 * askGroq() in groq.js and the /ask route in server.js do NOT need to change
 * — they just consume whatever chunks come back from this function, same as
 * before the swap.
 */

import { getChunkById } from '../chunk-db.js';
import { searchSimilarChunks } from './qdrant.js';

/**
 * retrieveRelevantChunks
 * @param {object} env
 * @param {string} question
 * @param {object} opts - { topN, expandRelated }
 * @returns {Promise<object[]>} chunks, highest score first, deduped
 */
export async function retrieveRelevantChunks(env, question, opts = {}) {
  const topN = opts.topN ?? 4;
  const expandRelated = opts.expandRelated ?? true;

  if (!question || !question.trim()) return [];

  // Step 1: vector search in Qdrant — returns chunk_id + score + lightweight payload
  const hits = await searchSimilarChunks(env, question, topN);
  if (hits.length === 0) return [];

  // Step 2: hydrate full chunk rows from Neon (text, heading_path, related_ids, etc.)
  const top = [];
  for (const hit of hits) {
    const full = await getChunkById(env, hit.chunk_id);
    if (full) {
      top.push({ ...full, _score: hit.score, _via: 'vector-search' });
    }
  }

  const seen = new Set(top.map(c => c.id));
  const result = [...top];

  // Step 3: expand via cross-doc related_ids, same as before the swap
  if (expandRelated) {
    for (const c of top) {
      for (const relId of (c.related_ids || [])) {
        if (seen.has(relId)) continue;
        const related = await getChunkById(env, relId);
        if (related) {
          result.push({ ...related, _score: 0, _via: `related_id of ${c.id}` });
          seen.add(relId);
        }
      }
    }
  }

  return result;
}