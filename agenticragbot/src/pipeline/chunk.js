/**
 * kb-pipeline/chunk.js
 * ──────────────────────────────────────────────────────────────────────────────
 * PHASE B — CHUNK (graph-interconnected, vector-DB-native — no graph DB)
 *
 * Consumes the topic tree produced by clean.js and turns it into a flat
 * array of chunk objects, each carrying enough structure to act like a node
 * in a graph even though it will live as flat rows/vectors in Qdrant /
 * Upstash Vector:
 *
 *   - prev_id / next_id     → linear sibling order (reading order)
 *   - parent_id / children  → heading hierarchy (topic → subtopic)
 *   - related_ids           → CROSS-DOCUMENT links: chunks elsewhere in the
 *                             KB whose topic title matches this chunk's,
 *                             resolved via the memory index (memory.js).
 *                             This is what makes retrieval "interconnected"
 *                             without needing Neo4j/a graph DB — the edges
 *                             are just an array of ids stored alongside the
 *                             vector, and the agent walks them after the
 *                             initial similarity search.
 *
 * Token sizing: TARGET 300, MIN 80 (merge), MAX 512 (split).
 */

const TARGET_TOKENS = 300;
const MIN_TOKENS = 80;
const MAX_TOKENS = 512;
const CHARS_PER_TOKEN = 4;

/**
 * @param {object[]} topics   - topic tree from clean.js
 * @param {object}   frontMatter
 * @param {string}   docId
 * @param {object}   memoryIndex - optional: { "<normalized topic title>": [{docId, chunkId}] }
 *                                 built from previously-processed docs' memory.json files.
 *                                 Pass {} for a single-doc run.
 * @returns {object[]} flat array of chunk objects, graph-wired
 */
export function chunkTopicTree(topics, frontMatter, docId, memoryIndex = {}) {
  const flat = [];
  flattenWithSizing(topics, docId, frontMatter, flat);

  wireSiblingsAndHierarchy(flat);
  wireCrossDocLinks(flat, memoryIndex);

  return flat;
}

// ─── flatten + size each topic into one or more chunks ──────────────────────

function flattenWithSizing(topics, docId, frontMatter, out, parentChunkId = null, indexRef = { i: 0 }) {
  for (const topic of topics) {
    const headingText = `${'#'.repeat(Math.min(topic.level, 3))} ${topic.title}`;
    const bodyText = [headingText, '', ...topic.paragraphs].join('\n');
    const tokenEstimate = Math.ceil(bodyText.length / CHARS_PER_TOKEN);

    let thisTopicChunkIds = [];

    if (tokenEstimate <= MAX_TOKENS) {
      const chunk = buildChunk(bodyText, topic, docId, indexRef.i++, frontMatter, parentChunkId);
      out.push(chunk);
      thisTopicChunkIds = [chunk.id];
    } else {
      // Oversized topic body → paragraph-boundary split, all sub-chunks
      // still belong to the same heading_path / parent.
      const subChunks = splitOversized(topic, docId, indexRef, frontMatter, parentChunkId);
      out.push(...subChunks);
      thisTopicChunkIds = subChunks.map(c => c.id);
    }

    // Children attach to the LAST chunk produced for this topic (so a long
    // intro followed by subheadings reads naturally parent → child).
    const newParent = thisTopicChunkIds[thisTopicChunkIds.length - 1];
    if (topic.children.length) {
      flattenWithSizing(topic.children, docId, frontMatter, out, newParent, indexRef);
    }
  }
}

function buildChunk(text, topic, docId, index, frontMatter, parentChunkId) {
  const slug = slugify(topic.title);
  const tokenCount = Math.ceil(text.length / CHARS_PER_TOKEN);

  return {
    id: `${docId}#${slug}-${index}`,
    doc_id: docId,
    index,
    source_url: frontMatter.source_url || frontMatter.title || '',
    heading_path: topic.path,
    slug,
    text: text.trim(),
    token_count: tokenCount,
    images: topic.images || [],
    has_images: (topic.images || []).length > 0,
    // graph fields, wired below
    prev_id: null,
    next_id: null,
    parent_id: parentChunkId,
    children_ids: [],
    related_ids: [],
    graph_role: null,
  };
}

function splitOversized(topic, docId, indexRef, frontMatter, parentChunkId) {
  const heading = `${'#'.repeat(Math.min(topic.level, 3))} ${topic.title}`;
  const paras = topic.paragraphs;
  const sub = [];
  let buf = [heading, ''];
  let bufHasHeading = true;

  const flush = () => {
    if (buf.filter(Boolean).length <= 1 && bufHasHeading) return;
    sub.push(buildChunk(buf.join('\n'), topic, docId, indexRef.i++, frontMatter, parentChunkId));
    buf = [];
    bufHasHeading = false;
  };

  for (const p of paras) {
    buf.push(p, '');
    if (buf.join('\n').length >= TARGET_TOKENS * CHARS_PER_TOKEN) flush();
  }
  flush();

  if (sub.length === 0) {
    sub.push(buildChunk(heading, topic, docId, indexRef.i++, frontMatter, parentChunkId));
  }
  return sub;
}

// ─── prev/next + parent/children bookkeeping ─────────────────────────────────

function wireSiblingsAndHierarchy(chunks) {
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) chunks[i].prev_id = chunks[i - 1].id;
    if (i < chunks.length - 1) chunks[i].next_id = chunks[i + 1].id;
  }

  const byId = new Map(chunks.map(c => [c.id, c]));
  for (const c of chunks) {
    if (c.parent_id && byId.has(c.parent_id)) {
      const parent = byId.get(c.parent_id);
      if (!parent.children_ids.includes(c.id)) parent.children_ids.push(c.id);
    }
  }

  for (const c of chunks) {
    c.graph_role = !c.parent_id ? 'root' : c.children_ids.length ? 'branch' : 'leaf';
  }

  // Merge sub-MIN_TOKENS leaf chunks into their previous sibling so the KB
  // doesn't fill up with near-empty vectors.
  for (let i = chunks.length - 1; i > 0; i--) {
    if (chunks[i].token_count < MIN_TOKENS && chunks[i].graph_role === 'leaf') {
      const prev = chunks[i - 1];
      if (prev.doc_id === chunks[i].doc_id) {
        prev.text += '\n\n' + chunks[i].text;
        prev.token_count = Math.ceil(prev.text.length / CHARS_PER_TOKEN);
        prev.children_ids.push(chunks[i].id);
        chunks.splice(i, 1);
      }
    }
  }
}

// ─── cross-document graph edges, resolved via the memory index ──────────────
// This is the "interconnected chunking" piece: no graph DB, just an edge
// list living next to each vector. memoryIndex maps a normalized topic
// title → every (docId, chunkId) elsewhere in the KB that used that title,
// built incrementally by memory.js as each document is processed.

function wireCrossDocLinks(chunks, memoryIndex) {
  for (const c of chunks) {
    const key = normalizeTitle(c.heading_path[c.heading_path.length - 1] || '');
    const matches = memoryIndex[key] || [];
    c.related_ids = matches
      .filter(m => m.docId !== c.doc_id)
      .map(m => m.chunkId)
      .slice(0, 5);
  }
}

export function normalizeTitle(title) {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
}