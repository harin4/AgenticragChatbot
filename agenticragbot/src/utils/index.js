/**
 * kb-pipeline/index.js — Clean-and-Chunk API
 * ────────────────────────────────────────────────────────────────────────────
 * Exports the unified cleanAndChunkMarkdown(markdown, docId) function.
 * This module wraps clean.js and chunk.js and is used by:
 *   1. CLI (node scripts/clean-and-chunk.js)
 *   2. Express server (server.js → /process/doc)
 *   3. Lambda / worker functions (for batch processing)
 *
 * DESIGN:
 *   clean.js produces: { frontMatter, topics, alerts, stats }
 *     - topics: hierarchical tree (H1 → H2 → H3) with paragraphs & images
 *     - alerts: every decision (dropped/kept images, dedups, promotions)
 *
 *   chunk.js consumes topics and produces: { id, doc_id, text, token_count, ...graph edges }
 *     - flat array of chunks with prev/next (linear) + parent/children (hierarchy)
 *     - ready for vector DB (Qdrant, Upstash) without graph DB
 */

import { cleanMarkdown, renderTopicTree, parseFrontMatter } from './clean.js';
import { chunkTopicTree } from './chunk.js';

/**
 * cleanAndChunkMarkdown
 *
 * PHASE A: Clean (clean.js)
 *   1. Parse YAML front matter
 *   2. Triage images: drop (no alt) or keep + link to topic node
 *   3. Strip boilerplate: nav, cookies, footer, "share", etc.
 *   4. Re-flow: merge soft-wrapped sentences, promote **Bold** to ### headings
 *   5. Build topic tree: hierarchical H1 → H2 → H3 with full content
 *   6. Deduplicate: remove repeated topics (scraper artifacts)
 *
 * PHASE B: Chunk (chunk.js)
 *   1. Flatten topic tree to chunks (one chunk per topic, or split if > 512 tokens)
 *   2. Wire siblings: prev_id ↔ next_id (reading order)
 *   3. Wire hierarchy: parent_id ↔ children_ids (topic tree)
 *   4. Wire cross-doc: related_ids (if memoryIndex provided)
 *   5. Tag roles: root | branch | leaf
 *
 * @param {string} rawMarkdown - Raw markdown from Jina
 * @param {string} docId - Document ID (for chunk IDs)
 * @param {object} memoryIndex - Optional: { "<normalized topic>": [{docId, chunkId}] }
 *                               for cross-document linking
 * @returns {Promise<Object>} { cleaned, chunks, alerts }
 *   - cleaned: { lines: string[], markdown: string }
 *   - chunks: ChunkObject[] (graph-wired, ready for embeddings)
 *   - alerts: Array of { type, message, line? }
 */
export async function cleanAndChunkMarkdown(rawMarkdown, docId, memoryIndex = {}) {
  // ── Phase A: Clean ─────────────────────────────────────────────────────────
  const { frontMatter, topics, alerts, stats } = cleanMarkdown(rawMarkdown, docId);

  // ── Phase B: Chunk ─────────────────────────────────────────────────────────
  const chunks = chunkTopicTree(topics, frontMatter, docId, memoryIndex);

  // ── Consolidate alerts ─────────────────────────────────────────────────────
  const allAlerts = alerts.map(a => ({
    type: a.type,
    message:
      a.type === 'DROPPED_IMAGE' ? `Dropped image (no alt text): ${a.url.slice(0, 80)}`
      : a.type === 'KEPT_IMAGE' ? `Kept image: "${a.alt}"`
      : a.type === 'STRIPPED_BOILERPLATE' ? `Stripped: "${a.text.slice(0, 60)}"`
      : a.type === 'PROMOTED_HEADING' ? `Promoted to heading: "${a.text}"`
      : a.type === 'DEDUPED_TOPIC' ? `Deduplicated: "${a.text}"`
      : a.type === 'NO_H1_FOUND' ? `Synthesized root topic: "${a.text}"`
      : a.message || a.type,
    line: a.line,
  }));

  // ── Clean markdown output (for audit / storage in Neon clean_markdown column)
  const cleanedMarkdown = renderTopicTree(frontMatter, topics);

  return {
    cleaned: {
      lines: cleanedMarkdown.split('\n'),
      markdown: cleanedMarkdown,
      stats,
    },
    chunks,
    alerts: allAlerts,
  };
}

/**
 * Utility: Re-render markdown from topic tree (for testing)
 */
export function renderCleanMarkdown(frontMatter, topics) {
  return renderTopicTree(frontMatter, topics);
}

export default cleanAndChunkMarkdown;