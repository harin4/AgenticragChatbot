/**
 * src/services/qdrant.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Vector layer. Mirrors the shape of chunk-db.js / groq.js so it slots into
 * the existing pattern: getQdrantClient() like getDb(), ensureCollection()
 * like initChunkSchema(), upsertChunkVectors() like saveChunks().
 *
 * Payload stored alongside each vector intentionally duplicates a few fields
 * already in Neon (doc_id, heading_path, slug, graph_role). This is a
 * deliberate denormalization: it lets retrieve.js filter/display results
 * straight from the Qdrant response without a round-trip to Neon for every
 * chunk, only the FULL row needs that extra fetch.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { embedQuery, embedDocuments, EMBEDDING_DIM } from './embeddings.js';

let _client = null;

export function getQdrantClient(env) {
  if (_client) return _client;
  const url = env.QDRANT_URL;
  const apiKey = env.QDRANT_API_KEY;
  if (!url) throw new Error('QDRANT_URL is not set');

  _client = new QdrantClient({ url, apiKey });
  return _client;
}

function collectionName(env) {
  return env.QDRANT_COLLECTION || 'mergex_chunks';
}

/**
 * ensureCollection — create the Qdrant collection if it doesn't exist yet.
 * Safe to call repeatedly (checks existence first). Run this once via
 * POST /init-vectors before the first upsert.
 */
export async function ensureCollection(env) {
  const client = getQdrantClient(env);
  const name = collectionName(env);

  const { collections } = await client.getCollections();
  const exists = collections.some(c => c.name === name);

  if (!exists) {
    await client.createCollection(name, {
      vectors: { size: EMBEDDING_DIM, distance: 'Cosine' },
    });
    console.log(`[qdrant] Created collection "${name}" (dim=${EMBEDDING_DIM})`);
    return { created: true, collection: name };
  }

  console.log(`[qdrant] Collection "${name}" already exists`);
  return { created: false, collection: name };
}

/**
 * Qdrant point IDs must be unsigned ints or UUIDs — your chunk ids are
 * strings like "<docId>#what-we-believe-1", which Qdrant rejects as a point
 * id. We keep chunk.id in the payload (untouched) and derive a stable UUIDv5
 * style numeric id purely for Qdrant's own indexing.
 */
function toPointId(chunkId) {
  let hash = 0;
  for (let i = 0; i < chunkId.length; i++) {
    hash = (hash * 31 + chunkId.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * upsertChunkVectors — embed chunk text and push to Qdrant.
 * Call this right after saveChunks(env, chunks) in server.js so Neon and
 * Qdrant always stay in sync for the same set of chunks.
 */
export async function upsertChunkVectors(env, chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return { upserted: 0 };

  const client = getQdrantClient(env);
  const name = collectionName(env);

  const texts = chunks.map(c => c.text);
  const vectors = await embedDocuments(env, texts);

  const points = chunks.map((c, i) => ({
    id: toPointId(c.id),
    vector: vectors[i],
    payload: {
      chunk_id: c.id,
      doc_id: c.doc_id,
      heading_path: c.heading_path || [],
      slug: c.slug,
      graph_role: c.graph_role,
      source_url: c.source_url,
    },
  }));

  await client.upsert(name, { wait: true, points });
  console.log(`[qdrant] Upserted ${points.length} vectors into "${name}"`);
  return { upserted: points.length };
}

/**
 * searchSimilarChunks — embed the query and run a vector search.
 * Returns lightweight hits ({ chunk_id, score, payload }), NOT full chunk
 * rows — retrieve.js fetches full rows from Neon by chunk_id afterward.
 */
export async function searchSimilarChunks(env, queryText, topN = 4) {
  const client = getQdrantClient(env);
  const name = collectionName(env);

  const queryVector = await embedQuery(env, queryText);

  const results = await client.search(name, {
    vector: queryVector,
    limit: topN,
    with_payload: true,
  });

  return results.map(r => ({
    chunk_id: r.payload.chunk_id,
    score: r.score,
    payload: r.payload,
  }));
}

/**
 * deleteChunkVector — remove a single chunk's vector (e.g. when a chunk is
 * deleted via DELETE /chunks/:chunkId in server.js — keep Qdrant in sync).
 */
export async function deleteChunkVector(env, chunkId) {
  const client = getQdrantClient(env);
  const name = collectionName(env);
  await client.delete(name, { points: [toPointId(chunkId)] });
}