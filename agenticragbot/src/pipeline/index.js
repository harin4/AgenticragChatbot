/**
 * kb-pipeline/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Unified entry point for the clean-and-chunk pipeline.
 * Re-exports cleanAndChunkMarkdown so server.js can import from this folder.
 *
 * FIX: server.js imports from './kb-pipeline/index.js' but this file was
 * missing. src/index.js had the right implementation but wrong import paths
 * (it pointed at ./clean.js and ./chunk.js — which are here in kb-pipeline/).
 * This file is the canonical entry point. src/index.js is kept for back-compat.
 */

import { cleanMarkdown, renderTopicTree, parseFrontMatter } from './clean.js';
import { chunkTopicTree } from './chunk.js';

/**
 * cleanAndChunkMarkdown
 *
 * PHASE A — Clean (clean.js)
 *   1. Parse YAML front matter
 *   2. Triage images: drop (no alt) → alert DROPPED_IMAGE, keep → alert KEPT_IMAGE
 *   3. Strip boilerplate: nav, cookies, footer noise
 *   4. Re-flow: merge hard-wrapped sentence fragments, promote **Bold** → ### headings
 *   5. Build topic tree: H1 → H2 → H3 hierarchy with paragraphs + images attached
 *   6. Deduplicate repeated sections (scraper artifacts)
 *
 * PHASE B — Chunk (chunk.js)
 *   1. Flatten topic tree → chunks (one per topic, split if > 512 tokens)
 *   2. Wire prev_id ↔ next_id (reading/sibling order)
 *   3. Wire parent_id ↔ children_ids (topic hierarchy)
 *   4. Wire related_ids (cross-doc links via memoryIndex)
 *   5. Tag graph_role: root | branch | leaf
 *
 * @param {string} rawMarkdown   - Raw Jina markdown (YAML front matter + body)
 * @param {string} docId         - Document slug (e.g. "about", "services")
 * @param {object} memoryIndex   - Optional cross-doc index for related_ids wiring
 * @returns {{ cleaned, chunks, alerts }}
 */
export async function cleanAndChunkMarkdown(rawMarkdown, docId, memoryIndex = {}) {
  // Phase A
  const { frontMatter, topics, alerts, stats } = cleanMarkdown(rawMarkdown, docId);

  // Phase B
  const chunks = chunkTopicTree(topics, frontMatter, docId, memoryIndex);

  // Format alerts for server.js response
  const formattedAlerts = alerts.map(a => ({
    type:    a.type,
    message: formatAlertMessage(a),
    line:    a.line,
  }));

  // Cleaned markdown for Neon storage (human-readable, audit-ready)
  const cleanedMarkdown = renderTopicTree(frontMatter, topics);

  return {
    cleaned: {
      lines:    cleanedMarkdown.split('\n'),
      markdown: cleanedMarkdown,
      stats,
    },
    chunks,
    alerts: formattedAlerts,
  };
}

function formatAlertMessage(a) {
  switch (a.type) {
    case 'DROPPED_IMAGE':    return `Dropped image (no alt): ${(a.url || '').slice(0, 80)}`;
    case 'KEPT_IMAGE':       return `Kept image: "${a.alt}"`;
    case 'STRIPPED_BOILERPLATE': return `Stripped: "${(a.text || '').slice(0, 60)}"`;
    case 'PROMOTED_HEADING': return `Promoted to heading: "${a.text}"`;
    case 'DEDUPED_TOPIC':    return `Deduplicated topic: "${a.text}"`;
    case 'NO_H1_FOUND':      return `Synthesized root: "${a.text}"`;
    default:                 return a.message || a.type;
  }
}

export default cleanAndChunkMarkdown;
