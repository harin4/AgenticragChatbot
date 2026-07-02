/**
 * features/langchain-agent/server/lib/embeddings.js
 * ──────────────────────────────────────────────────────────────────────────
 * LangChain's official Cohere connector. Replaces the raw fetch() wrapper in
 * src/services/embeddings.js. Same model (embed-english-v3.0, 1024 dims) so
 * vectors stay compatible with what's already in the Qdrant collection.
 *
 * CohereEmbeddings picks input_type automatically:
 *   embedQuery()     -> "search_query"    (used for the user's question)
 *   embedDocuments()  -> "search_document" (not used by this read-only feature,
 *                        the KB pipeline already owns writes to Qdrant)
 */

import { CohereEmbeddings } from '@langchain/cohere';

export const EMBEDDING_DIM = 1024;
export const EMBEDDING_MODEL = 'embed-english-v3.0';

export function createEmbeddings(env) {
  return new CohereEmbeddings({
    apiKey: env.COHERE_API_KEY,
    model: EMBEDDING_MODEL,
  });
}
