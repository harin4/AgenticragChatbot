/**
 * features/langchain-agent/server/lib/vectorstore.js
 * ──────────────────────────────────────────────────────────────────────────
 * LangChain's official Qdrant connector, pointed at the EXISTING collection
 * the ingestion pipeline (src/services/qdrant.js) already writes to. No
 * schema change, no re-embedding, no new collection.
 *
 * Why contentPayloadKey/metadataPayloadKey are set the way they are:
 * QdrantVectorStore expects each point's payload to carry the raw text under
 * a "content" key and everything else under a nested "metadata" key. This
 * collection was populated directly (see src/services/qdrant.js) with a
 * FLAT payload — { chunk_id, doc_id, heading_path, slug, graph_role,
 * source_url } — and no chunk text at all (Neon is the source of truth for
 * text). Pointing contentPayloadKey at "chunk_id" makes similaritySearch
 * return Document.pageContent = chunk_id, which is exactly the join key we
 * need to hydrate the full chunk (text, heading_path, related_ids, ...) from
 * Neon afterward, the same two-step pattern src/services/retrieve.js already
 * uses.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { QdrantVectorStore } from '@langchain/qdrant';

let _store = null;

export async function getVectorStore(env, embeddings) {
  if (_store) return _store;

  const client = new QdrantClient({
    url: env.QDRANT_URL,
    apiKey: env.QDRANT_API_KEY,
  });

  _store = await QdrantVectorStore.fromExistingCollection(embeddings, {
    client,
    collectionName: env.QDRANT_COLLECTION,
    contentPayloadKey: 'chunk_id',
    metadataPayloadKey: 'doc_id',
  });

  return _store;
}

/**
 * vectorSearch — embed the query via the LangChain Cohere connector and run
 * similarity search via the LangChain Qdrant connector.
 * @returns {Promise<{chunkId: string, score: number}[]>}
 */
export async function vectorSearch(env, embeddings, query, k = 4) {
  const store = await getVectorStore(env, embeddings);
  const results = await store.similaritySearchWithScore(query, k);
  return results.map(([doc, score]) => ({ chunkId: doc.pageContent, score }));
}
