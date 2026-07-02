/**
 * features/langchain-agent/server/lib/chunkStore.js
 * ──────────────────────────────────────────────────────────────────────────
 * Thin re-export of the existing Neon chunk reads from src/chunk-db.js.
 * The KB pipeline (chunking, related_ids graph) is explicitly out of scope
 * for this feature — we only ever READ chunks here, never write, so we
 * reuse the same data-access functions rather than duplicating SQL.
 */

export { getChunkById } from '../../../../src/chunk-db.js';
