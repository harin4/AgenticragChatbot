/**
 * src/chunk-db.js — Chunk metadata layer for Neon Postgres
 */

import { Client } from '@neondatabase/serverless';

import { withClient } from './services/db.js';
import {
  hasR2,
  isR2Primary,
  buildChunksJsonR2Key,
  getFromR2,
} from './services/storage.js';

async function getChunksJsonR2KeyForDoc(env, docId, client) {
  const res = await client.query(
    `SELECT chunks_json_r2_key FROM kb_documents WHERE id = $1 LIMIT 1`,
    [docId]
  );
  return res.rows[0]?.chunks_json_r2_key || buildChunksJsonR2Key(docId);
}

async function hydrateChunkTexts(env, chunks, client) {
  if (!chunks?.length || !hasR2(env) || !isR2Primary(env)) return chunks;
  if (!chunks.some((c) => !c.text?.trim())) return chunks;

  const docId = chunks[0].doc_id;
  const r2Key = await getChunksJsonR2KeyForDoc(env, docId, client);
  const obj = await getFromR2(env, r2Key);
  if (!obj?.content) return chunks;

  let fromR2;
  try {
    fromR2 = JSON.parse(obj.content);
  } catch {
    return chunks;
  }

  const textById = Object.fromEntries(fromR2.map((c) => [c.id, c.text]));
  return chunks.map((c) => ({
    ...c,
    text: c.text?.trim() ? c.text : (textById[c.id] || c.text || ''),
  }));
}

// ─── Schema ───────────────────────────────────────────────────────────────────

export async function initChunkSchema(env) {
  return withClient(env, async (client) => {
    let hasVector = false;
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
      hasVector = true;
    } catch (err) {
      console.warn('[chunk-db] pgvector extension unavailable — creating kb_chunks without embedding column');
    }

    const embeddingCol = hasVector ? 'embedding vector(384) DEFAULT NULL,' : '';

    await client.query(`
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
        ${embeddingCol}
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc_id    ON kb_chunks(doc_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_graph_role ON kb_chunks(graph_role)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_slug       ON kb_chunks(slug)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS kb_chunk_memory (
        id          TEXT        PRIMARY KEY,
        chunk_graph JSONB       NOT NULL,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    console.log('[chunk-db] Schema initialized: kb_chunks, kb_chunk_memory');
    return { status: 'ok', tables: ['kb_chunks', 'kb_chunk_memory'] };
  });
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function saveChunks(env, chunks) {
  return withClient(env, async (client) => {
    if (!Array.isArray(chunks) || chunks.length === 0) return [];

    const stripText = hasR2(env) && isR2Primary(env);
    const savedIds = [];
    for (const c of chunks) {
      const text = stripText ? '' : c.text;
      await client.query(`
        INSERT INTO kb_chunks (
          id, doc_id, "index", source_url, heading_path, slug, text,
          token_count, has_images, graph_role,
          prev_id, next_id, parent_id, children_ids, related_ids, images,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10,
          $11, $12, $13, $14, $15, $16,
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
      `, [
        c.id, c.doc_id, c.index, c.source_url || null,
        JSON.stringify(c.heading_path || []), c.slug, text,
        c.token_count, c.has_images || false, c.graph_role,
        c.prev_id || null, c.next_id || null, c.parent_id || null,
        JSON.stringify(c.children_ids || []),
        JSON.stringify(c.related_ids || []),
        JSON.stringify(c.images || [])
      ]);
      savedIds.push(c.id);
    }
    console.log(`[chunk-db] Saved/updated ${savedIds.length} chunks${stripText ? ' (text in R2)' : ''}`);
    return savedIds;
  });
}

export async function saveChunkMemory(env, docId, memoryMap) {
  return withClient(env, async (client) => {
    await client.query(`
      INSERT INTO kb_chunk_memory (id, chunk_graph, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (id) DO UPDATE SET
        chunk_graph = EXCLUDED.chunk_graph,
        updated_at  = NOW()
    `, [docId, JSON.stringify(memoryMap)]);
    console.log(`[chunk-db] Saved memory graph for docId=${docId}`);
  });
}

export async function buildMemoryIndexFromDB(env) {
  return withClient(env, async (client) => {
    const { normalizeTitle } = await import('./pipeline/chunk.js');
    const index = {};
    // Query only lightweight metadata columns, avoiding the massive text and vector columns
    const res = await client.query(`SELECT id, doc_id, heading_path FROM kb_chunks`);
    
    for (const row of res.rows) {
      const headingPath = typeof row.heading_path === 'string' ? JSON.parse(row.heading_path) : (row.heading_path || []);
      for (const title of headingPath) {
        const key = normalizeTitle(title);
        if (!key) continue;
        if (!index[key]) index[key] = [];
        
        if (!index[key].some(m => m.docId === row.doc_id && m.chunkId === row.id)) {
          index[key].push({ docId: row.doc_id, chunkId: row.id });
        }
      }
    }
    return index;
  });
}

export async function getAllChunkMemories(env) {
  return withClient(env, async (client) => {
    const res = await client.query(`SELECT id, chunk_graph FROM kb_chunk_memory ORDER BY updated_at ASC`);
    return res.rows.map(r => ({
      docId: r.id,
      ...(typeof r.chunk_graph === 'string' ? JSON.parse(r.chunk_graph) : r.chunk_graph),
    }));
  });
}

export async function updateChunkRelatedIds(env, chunkId, relatedIds) {
  return withClient(env, async (client) => {
    await client.query(`
      UPDATE kb_chunks
      SET related_ids = $1, updated_at = NOW()
      WHERE id = $2
    `, [JSON.stringify(relatedIds), chunkId]);
  });
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getChunksByDocId(env, docId, limit = 50, offset = 0) {
  return withClient(env, async (client) => {
    const res = await client.query(`
      SELECT * FROM kb_chunks
      WHERE doc_id = $1
      ORDER BY "index" ASC
      LIMIT $2 OFFSET $3
    `, [docId, limit, offset]);
    return hydrateChunkTexts(env, res.rows, client);
  });
}

export async function getChunkById(env, chunkId) {
  return withClient(env, async (client) => {
    const res = await client.query(`SELECT * FROM kb_chunks WHERE id = $1 LIMIT 1`, [chunkId]);
    const row = res.rows[0] || null;
    if (!row) return null;
    const [hydrated] = await hydrateChunkTexts(env, [row], client);
    return hydrated;
  });
}

export async function getChunkMemory(env, docId) {
  return withClient(env, async (client) => {
    const res = await client.query(`SELECT chunk_graph FROM kb_chunk_memory WHERE id = $1 LIMIT 1`, [docId]);
    return res.rows[0]?.chunk_graph || null;
  });
}

export async function listDocsNeedingChunking(env, limit = 20) {
  return withClient(env, async (client) => {
    const res = await client.query(`
      SELECT d.id, d.url, d.title, d.word_count
      FROM kb_documents d
      LEFT JOIN kb_chunk_memory m ON d.id = m.id
      WHERE m.id IS NULL
      ORDER BY d.scraped_at DESC
      LIMIT $1
    `, [limit]);
    return res.rows;
  });
}

// ─── Delete (cascade graph edges) ────────────────────────────────────────────

export async function deleteChunkCascade(env, chunkId) {
  return withClient(env, async (client) => {
    const chunkRes = await client.query(`SELECT * FROM kb_chunks WHERE id = $1 LIMIT 1`, [chunkId]);
    const chunk = chunkRes.rows[0];
    if (!chunk) throw new Error(`Chunk ${chunkId} not found`);

    const docId = chunk.doc_id;
    if (chunk.prev_id) {
      await client.query(`UPDATE kb_chunks SET next_id = $1 WHERE id = $2`, [chunk.next_id || null, chunk.prev_id]);
    }
    if (chunk.next_id) {
      await client.query(`UPDATE kb_chunks SET prev_id = $1 WHERE id = $2`, [chunk.prev_id || null, chunk.next_id]);
    }
    if (chunk.parent_id) {
      const parentRes = await client.query(`SELECT * FROM kb_chunks WHERE id = $1 LIMIT 1`, [chunk.parent_id]);
      const parent = parentRes.rows[0];
      if (parent) {
        const children = typeof parent.children_ids === 'string' ? JSON.parse(parent.children_ids) : (parent.children_ids || []);
        const updated = children.filter(id => id !== chunkId);
        await client.query(`UPDATE kb_chunks SET children_ids = $1 WHERE id = $2`, [JSON.stringify(updated), chunk.parent_id]);
      }
    }

    await client.query(`DELETE FROM kb_chunks WHERE id = $1`, [chunkId]);
    console.log(`[chunk-db] Deleted chunk ${chunkId} (docId=${docId})`);
    return docId;
  });
}
