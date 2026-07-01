/**
 * kb-pipeline/memory.js
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MEMORY LAYER — this is the piece your mentor described as:
 * "memory.md files where defined topics and their chunks are referred to,
 *  for interconnected (graph) chunking across documents."
 *
 * WHAT THIS FILE DOES:
 *   1. buildMemoryIndex(allDocMemories)
 *      Takes every doc's saved memory map from Neon (kb_chunk_memory) and
 *      builds a flat lookup: normalizedTopicTitle → [{ docId, chunkId }, ...]
 *      This is what chunk.js receives as `memoryIndex` to populate related_ids.
 *
 *   2. renderMemoryMd(memoryMap)
 *      Renders a single doc's memory map as a physical memory.md file.
 *      This is the human-readable version your mentor was picturing —
 *      one file per document listing its topics, chunk IDs, and cross-links.
 *
 *   3. renderGlobalMemoryIndex(memoryIndex)
 *      Renders the cross-document topic index as a global memory-index.md.
 *      Shows which topics appear in multiple docs — these are the graph edges.
 *
 *   4. saveMemoryMdFiles(docId, memoryMap, chunks)
 *      Writes memory.md and <docId>.chunks.json to kb/memory/ folder.
 *      Called from server.js after saveChunks() so files are always current.
 *
 * WHY TWO FORMS (JSON in Neon + .md files)?
 *   - Neon kb_chunk_memory JSONB → machine-readable, queried by the chunker
 *     when a NEW document is being chunked (it loads the index, finds matches,
 *     writes related_ids into the new doc's chunks before saving them).
 *   - kb/memory/*.memory.md → human-readable, reviewable in VS Code / GitHub,
 *     gives you the "see and work in the cleaning process" the mentor described.
 *     The .md files are the audit trail and the review surface.
 *
 * HOW CROSS-DOC WIRING WORKS (the "interconnected chunking"):
 *
 *   Doc A (about) is processed first:
 *     → memoryIndex at time of chunking = {} (first doc, no prior memory)
 *     → chunks saved to Neon with related_ids = []
 *     → A's memory map saved to kb_chunk_memory
 *
 *   Doc B (home) is processed next:
 *     → loadMemoryIndex() loads ALL prior docs from kb_chunk_memory
 *     → builds: { "scale is not luck": [{ docId: "A", chunkId: "A#scale-1" }] }
 *     → chunk.js calls wireCrossDocLinks(chunks, memoryIndex)
 *     → B's chunk "Scale is not luck" gets related_ids = ["A#scale-1"]
 *     → ALSO: A's chunks that share topics with B need their related_ids updated
 *       → updateRelatedIds() does this back-fill
 *
 *   Result: every chunk across all docs knows which other chunks cover the
 *   same topic. The agent can walk from doc B's "Scale" chunk → doc A's
 *   "Scale" chunk without a graph DB — just array lookups.
 */


import { normalizeTitle } from './chunk.js';

// ─── Memory file output directory ─────────────────────────────────────────────
const MEMORY_DIR = process.env.MEMORY_DIR || './kb/memory';

// ════════════════════════════════════════════════════════════════════════════
// 1. BUILD CROSS-DOC MEMORY INDEX
// ════════════════════════════════════════════════════════════════════════════

/**
 * buildMemoryIndex
 *
 * Takes all memory maps already saved in Neon (array of chunk_graph rows)
 * and builds a flat lookup table for the chunker.
 *
 * @param {Array} allDocMemories  — rows from kb_chunk_memory.chunk_graph
 * @returns {object} memoryIndex  — { "normalized topic title": [{ docId, chunkId }] }
 *
 * Example output:
 * {
 *   "scale is not luck":  [{ docId: "abc", chunkId: "abc#scale-is-not-luck-1" }],
 *   "four rules":         [{ docId: "abc", chunkId: "abc#four-rules-4" },
 *                          { docId: "def", chunkId: "def#four-rules-2" }]
 * }
 */
export function buildMemoryIndex(allDocMemories) {
  const index = {};

  for (const memory of allDocMemories) {
    if (!memory?.chunks) continue;

    for (const chunk of memory.chunks) {
      // Index every level of the heading path, not just the leaf
      // This means "What we believe > Four rules" matches on both
      // "what we believe" AND "four rules"
      const headingPath = chunk.headingPath || chunk.heading_path || [];

      for (const title of headingPath) {
        const key = normalizeTitle(title);
        if (!key) continue;

        if (!index[key]) index[key] = [];

        // Avoid duplicate entries for the same chunk
        const exists = index[key].some(
          m => m.docId === memory.docId && m.chunkId === chunk.id
        );
        if (!exists) {
          index[key].push({ docId: memory.docId, chunkId: chunk.id });
        }
      }
    }
  }

  return index;
}

// ════════════════════════════════════════════════════════════════════════════
// 2. RENDER MEMORY.MD — per-document human-readable file
// ════════════════════════════════════════════════════════════════════════════

/**
 * renderMemoryMd
 *
 * Renders a single document's memory map as markdown.
 * This is the physical memory.md your mentor described — one per doc.
 *
 * @param {object} memoryMap  — from buildMemoryMap() in server.js
 * @param {Array}  chunks     — the full chunk array for this doc
 * @param {object} globalMemoryIndex  — cross-doc index (for showing related_ids context)
 * @returns {string}  — markdown content
 */
export function renderMemoryMd(memoryMap, chunks, globalMemoryIndex = {}) {
  const lines = [];
  const docId = memoryMap.docId;
  const sourceUrl = memoryMap.sourceUrl || memoryMap.source_url;
  const title = memoryMap.title;
  const timestamp = memoryMap.timestamp;
  const graphStats = memoryMap.graphStats;

  const normalizeChunk = (chunk) => {
    const headingPath = chunk.heading_path || chunk.headingPath || [];
    const childrenIds = chunk.children_ids || chunk.connections?.children || [];
    return {
      id: chunk.id,
      slug: chunk.slug,
      heading_path: headingPath,
      related_ids: chunk.related_ids || chunk.relatedIds || [],
      graph_role: chunk.graph_role || chunk.graphRole || 'leaf',
      token_count: chunk.token_count ?? chunk.tokenCount ?? 0,
      has_images: chunk.has_images ?? chunk.hasImages ?? false,
      prev_id: chunk.prev_id ?? chunk.connections?.prev ?? null,
      next_id: chunk.next_id ?? chunk.connections?.next ?? null,
      parent_id: chunk.parent_id ?? chunk.connections?.parent ?? null,
      children_ids: childrenIds,
      text: chunk.text || '',
    };
  };

  lines.push(`# Memory Map — ${title || docId}`);
  lines.push('');
  lines.push('> This file is auto-generated by the KB pipeline. Do not edit manually.');
  lines.push('> It is the cross-document topic index for this page — used by the');
  lines.push('> AI chunker to wire `related_ids` when new documents are processed.');
  lines.push('');
  lines.push('## Document Metadata');
  lines.push('');
  lines.push(`| Field       | Value |`);
  lines.push(`|-------------|-------|`);
  lines.push(`| **Doc ID**  | \`${docId}\` |`);
  lines.push(`| **URL**     | ${sourceUrl} |`);
  lines.push(`| **Title**   | ${title || '—'} |`);
  lines.push(`| **Updated** | ${timestamp} |`);
  lines.push('');

  lines.push('## Graph Stats');
  lines.push('');
  lines.push(`| Role   | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Root   | ${graphStats?.roots    || 0} |`);
  lines.push(`| Branch | ${graphStats?.branches || 0} |`);
  lines.push(`| Leaf   | ${graphStats?.leaves   || 0} |`);
  lines.push(`| Total  | ${graphStats?.total    || chunks.length} |`);
  lines.push('');

  lines.push('## Topic → Chunk Map');
  lines.push('');
  lines.push('Each topic section in this document maps to one or more chunks.');
  lines.push('The `related_ids` column shows chunks from OTHER documents that');
  lines.push('cover the same topic — this is the graph interconnection.');
  lines.push('');

  for (const raw of chunks) {
    const chunk = normalizeChunk(raw);
    const headingPath = chunk.heading_path.join(' › ');
    const related = chunk.related_ids || [];

    lines.push(`### ${headingPath || chunk.slug}`);
    lines.push('');
    lines.push(`| Field          | Value |`);
    lines.push(`|----------------|-------|`);
    lines.push(`| **Chunk ID**   | \`${chunk.id}\` |`);
    lines.push(`| **Slug**       | \`${chunk.slug}\` |`);
    lines.push(`| **Role**       | ${chunk.graph_role} |`);
    lines.push(`| **Tokens**     | ~${chunk.token_count} |`);
    lines.push(`| **Has Images** | ${chunk.has_images ? '✅ yes' : 'no'} |`);
    lines.push('');
    lines.push('**Graph connections:**');
    lines.push('');
    lines.push(`- Prev: \`${chunk.prev_id || 'none'}\``);
    lines.push(`- Next: \`${chunk.next_id || 'none'}\``);
    lines.push(`- Parent: \`${chunk.parent_id || 'none'}\``);
    lines.push(`- Children: ${(chunk.children_ids || []).length > 0
      ? (chunk.children_ids).map(id => `\`${id}\``).join(', ')
      : 'none'}`);

    if (related.length > 0) {
      lines.push('');
      lines.push('**Cross-document links (related_ids):**');
      lines.push('');
      for (const relId of related) {
        lines.push(`- \`${relId}\``);
      }
    } else {
      // Show potential cross-doc matches that WILL be wired when more docs arrive
      const path = chunk.heading_path || [];
      const lastTitle = path[path.length - 1] || '';
      const key = normalizeTitle(lastTitle);
      const potentialMatches = (globalMemoryIndex[key] || [])
        .filter(m => m.docId !== docId);

      if (potentialMatches.length > 0) {
        lines.push('');
        lines.push('**Cross-document links:** *(wired on next batch process)*');
        for (const m of potentialMatches) {
          lines.push(`- \`${m.chunkId}\` *(from doc ${m.docId})*`);
        }
      }
    }

    lines.push('');
    lines.push('**Content preview:**');
    lines.push('');
    lines.push('```');
    lines.push((chunk.text || '').slice(0, 200).trim() + (chunk.text?.length > 200 ? '…' : ''));
    lines.push('```');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// 3. RENDER GLOBAL MEMORY INDEX — cross-document topic index
// ════════════════════════════════════════════════════════════════════════════

/**
 * renderGlobalMemoryIndex
 *
 * Renders the full cross-document topic index as memory-index.md.
 * Shows which topics appear in multiple docs — those are the graph edges.
 *
 * This file is the "metadata map" your mentor described — the index of
 * what topics exist across the KB and where each one lives.
 *
 * @param {object} memoryIndex  — from buildMemoryIndex()
 * @param {Array}  allMemories  — all doc memory maps (for doc titles)
 * @returns {string}
 */
export function renderGlobalMemoryIndex(memoryIndex, allMemories = []) {
  const docTitles = {};
  for (const m of allMemories) {
    if (m?.docId) docTitles[m.docId] = m.title || m.sourceUrl || m.docId;
  }

  // Separate shared topics (multiple docs) from unique topics
  const sharedTopics = Object.entries(memoryIndex)
    .filter(([, refs]) => refs.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  const uniqueTopics = Object.entries(memoryIndex)
    .filter(([, refs]) => refs.length === 1);

  const lines = [];

  lines.push('# KB Global Memory Index');
  lines.push('');
  lines.push('> Auto-generated. This is the cross-document topic graph for the entire KB.');
  lines.push('> Topics listed under "Shared Topics" appear in multiple documents —');
  lines.push('> their chunks are linked via `related_ids` for graph traversal by agents.');
  lines.push('');
  lines.push(`**Last updated:** ${new Date().toISOString()}`);
  lines.push(`**Total topics indexed:** ${Object.keys(memoryIndex).length}`);
  lines.push(`**Shared across docs:** ${sharedTopics.length}`);
  lines.push(`**Doc count:** ${allMemories.length}`);
  lines.push('');

  if (sharedTopics.length > 0) {
    lines.push('## Shared Topics (Cross-Document Graph Edges)');
    lines.push('');
    lines.push('These topics are the graph edges — the same concept appears in multiple');
    lines.push('documents and their chunks are linked for agent traversal.');
    lines.push('');

    for (const [topic, refs] of sharedTopics) {
      lines.push(`### "${topic}"`);
      lines.push('');
      lines.push(`Appears in **${refs.length} documents:**`);
      lines.push('');

      for (const ref of refs) {
        const docTitle = docTitles[ref.docId] || ref.docId;
        lines.push(`- **${docTitle}** → \`${ref.chunkId}\``);
      }
      lines.push('');
    }
  }

  lines.push('## All Topics by Document');
  lines.push('');

  const byDoc = {};
  for (const [topic, refs] of Object.entries(memoryIndex)) {
    for (const ref of refs) {
      if (!byDoc[ref.docId]) byDoc[ref.docId] = [];
      byDoc[ref.docId].push({ topic, chunkId: ref.chunkId });
    }
  }

  for (const [docId, topics] of Object.entries(byDoc)) {
    const title = docTitles[docId] || docId;
    lines.push(`### ${title}`);
    lines.push(`*Doc ID: \`${docId}\`*`);
    lines.push('');
    for (const { topic, chunkId } of topics) {
      const isShared = (memoryIndex[topic] || []).length > 1;
      lines.push(`- ${isShared ? '🔗 ' : '  '}\`${topic}\` → \`${chunkId}\``);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * (Deprecated) saveMemoryMdFiles 
 * Left for backward compatibility if other modules import it, but it no longer writes to disk.
 */
export function saveMemoryMdFiles(docId, memoryMap, chunks, globalMemoryIndex = {}) {
  // Cloudflare Workers do not have `fs`. We no longer write files to disk.
  // Markdown generation is now done on-the-fly via the API.
  return { memoryPath: null, chunksPath: null };
}

/**
 * (Deprecated) saveGlobalMemoryIndex
 */
export function saveGlobalMemoryIndex(memoryIndex, allMemories) {
  return null;
}
