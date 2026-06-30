/**
 * src/chunk-db.js — Chunk metadata layer for Neon Postgres  (UPDATED)
 *
 * ADDED vs your current version:
 *   getAllChunkMemories()       — loads all docs' memory maps (for memoryIndex build)
 *   updateChunkRelatedIds()    — back-fills related_ids in existing chunks
 *
 * Everything else unchanged.
 */

import { neon } from '@neondatabase/serverless';

function getDb(env) {
  const url = env?.DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  return neon(url);
}

// ─── Schema ───────────────────────────────────────────────────────────────────

export async function initChunkSchema(env) {
  const sql = getDb(env);

  await sql`
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id           TEXT        PRIMARY KEY,
      doc_id       TEXT        NOT NULL,
      "index"      INTEGER     NOT NULL,
      source_url   TEXT,
      heading_path JSONB       DEFAULT '[]',
      slug         TEXT,
      text         TEXT        NOT NULL,
      token_count  INTEGER,
      has_images   BOOLEAN     DEFAULT false,
      graph_role   TEXT        CHECK (graph_role IN ('root', 'branch', 'leaf')),
      prev_id      TEXT,
      next_id      TEXT,
      parent_id    TEXT,
      children_ids JSONB       DEFAULT '[]',
      related_ids  JSONB       DEFAULT '[]',
      images       JSONB       DEFAULT '[]',
      embedding    vector(384) DEFAULT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc_id    ON kb_chunks(doc_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_kb_chunks_graph_role ON kb_chunks(graph_role)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_kb_chunks_slug       ON kb_chunks(slug)`;

  await sql`
    CREATE TABLE IF NOT EXISTS kb_chunk_memory (
      id          TEXT        PRIMARY KEY,
      chunk_graph JSONB       NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  console.log('[chunk-db] Schema initialized: kb_chunks, kb_chunk_memory');
  return { status: 'ok', tables: ['kb_chunks', 'kb_chunk_memory'] };
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function saveChunks(env, chunks) {
  const sql = getDb(env);
  if (!Array.isArray(chunks) || chunks.length === 0) return [];

  const savedIds = [];
  for (const c of chunks) {
    await sql`
      INSERT INTO kb_chunks (
        id, doc_id, "index", source_url, heading_path, slug, text,
        token_count, has_images, graph_role,
        prev_id, next_id, parent_id, children_ids, related_ids, images,
        updated_at
      )
      VALUES (
        ${c.id}, ${c.doc_id}, ${c.index}, ${c.source_url || null},
        ${JSON.stringify(c.heading_path || [])}, ${c.slug}, ${c.text},
        ${c.token_count}, ${c.has_images || false}, ${c.graph_role},
        ${c.prev_id || null}, ${c.next_id || null}, ${c.parent_id || null},
        ${JSON.stringify(c.children_ids || [])},
        ${JSON.stringify(c.related_ids || [])},
        ${JSON.stringify(c.images || [])},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        text         = EXCLUDED.text,
        token_count  = EXCLUDED.token_count,
        has_images   = EXCLUDED.has_images,
        graph_role   = EXCLUDED.graph_role,
        prev_id      = EXCLUDED.prev_id,
        next_id      = EXCLUDED.next_id,
        parent_id    = EXCLUDED.parent_id,
        children_ids = EXCLUDED.children_ids,
        related_ids  = EXCLUDED.related_ids,
        images       = EXCLUDED.images,
        updated_at   = NOW()
    `;
    savedIds.push(c.id);
  }
  console.log(`[chunk-db] Saved/updated ${savedIds.length} chunks`);
  return savedIds;
}

export async function saveChunkMemory(env, docId, memoryMap) {
  const sql = getDb(env);
  await sql`
    INSERT INTO kb_chunk_memory (id, chunk_graph, updated_at)
    VALUES (${docId}, ${JSON.stringify(memoryMap)}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      chunk_graph = EXCLUDED.chunk_graph,
      updated_at  = NOW()
  `;
  console.log(`[chunk-db] Saved memory graph for docId=${docId}`);
}

// ─── NEW: Load ALL docs' memory maps ─────────────────────────────────────────
// This is what server.js calls to build the cross-doc memoryIndex
// before chunking a new document.

export async function getAllChunkMemories(env) {
  const sql = getDb(env);
  const rows = await sql`
    SELECT id, chunk_graph FROM kb_chunk_memory ORDER BY updated_at ASC
  `;
  // chunk_graph is JSONB — Neon returns it already parsed
  return rows.map(r => ({
    docId: r.id,
    ...(typeof r.chunk_graph === 'string' ? JSON.parse(r.chunk_graph) : r.chunk_graph),
  }));
}

// ─── NEW: Back-fill related_ids on existing chunks ───────────────────────────
// Called after processing a new doc to update PRIOR chunks that share topics.

export async function updateChunkRelatedIds(env, chunkId, relatedIds) {
  const sql = getDb(env);
  await sql`
    UPDATE kb_chunks
    SET related_ids = ${JSON.stringify(relatedIds)}, updated_at = NOW()
    WHERE id = ${chunkId}
  `;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getChunksByDocId(env, docId, limit = 50, offset = 0) {
  const sql = getDb(env);
  return sql`
    SELECT * FROM kb_chunks
    WHERE doc_id = ${docId}
    ORDER BY "index" ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function getChunkById(env, chunkId) {
  const sql = getDb(env);
  const rows = await sql`SELECT * FROM kb_chunks WHERE id = ${chunkId} LIMIT 1`;
  return rows[0] || null;
}

/**
 * getAllChunks
 * Every chunk in the KB, across every doc. Used by src/services/retrieve.js
 * for keyword-based retrieval until Layer 2 embeddings/vector search exist —
 * fine at this KB size (handful of docs), will need a real vector query
 * once the KB grows past what fits comfortably in memory per request.
 */
export async function getAllChunks(env) {
  const sql = getDb(env);
  return sql`SELECT * FROM kb_chunks ORDER BY doc_id, "index" ASC`;
}

export async function getChunkMemory(env, docId) {
  const sql = getDb(env);
  const rows = await sql`
    SELECT chunk_graph FROM kb_chunk_memory WHERE id = ${docId} LIMIT 1
  `;
  return rows[0]?.chunk_graph || null;
}

export async function listDocsNeedingChunking(env, limit = 20) {
  const sql = getDb(env);
  return sql`
    SELECT d.id, d.url, d.title, d.word_count
    FROM kb_documents d
    LEFT JOIN kb_chunk_memory m ON d.id = m.id
    WHERE m.id IS NULL
    ORDER BY d.created_at DESC
    LIMIT ${limit}
  `;
}

// ─── Delete (cascade graph edges) ────────────────────────────────────────────

export async function deleteChunkCascade(env, chunkId) {
  const sql = getDb(env);
  const chunk = await getChunkById(env, chunkId);
  if (!chunk) throw new Error(`Chunk ${chunkId} not found`);

  const docId = chunk.doc_id;
  if (chunk.prev_id) {
    await sql`UPDATE kb_chunks SET next_id = ${chunk.next_id || null} WHERE id = ${chunk.prev_id}`;
  }
  if (chunk.next_id) {
    await sql`UPDATE kb_chunks SET prev_id = ${chunk.prev_id || null} WHERE id = ${chunk.next_id}`;
  }
  if (chunk.parent_id) {
    const parent = await getChunkById(env, chunk.parent_id);
    if (parent) {
      const updated = (parent.children_ids || []).filter(id => id !== chunkId);
      await sql`UPDATE kb_chunks SET children_ids = ${JSON.stringify(updated)} WHERE id = ${chunk.parent_id}`;
    }
  }

  await sql`DELETE FROM kb_chunks WHERE id = ${chunkId}`;
  console.log(`[chunk-db] Deleted chunk ${chunkId} (docId=${docId})`);
  return docId;
}