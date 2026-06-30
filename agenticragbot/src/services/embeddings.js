/**
 * src/services/embeddings.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Thin wrapper around an embedding provider so qdrant.js never has to know
 * which provider is in use. Default: Cohere embed-english-v3.0 (1024 dims).
 *
 * Cohere requires an `input_type`:
 *   - 'search_document' when embedding chunks going INTO the vector DB
 *   - 'search_query'    when embedding the user's question at query time
 * Using the wrong one silently hurts retrieval quality, so both helpers
 * below are explicit about which type they call.
 */

const COHERE_EMBED_URL = 'https://api.cohere.com/v1/embed';
export const EMBEDDING_DIM = 1024; // embed-english-v3.0 output size

async function callCohereEmbed(env, texts, inputType) {
  const apiKey = env.COHERE_API_KEY;
  if (!apiKey) throw new Error('COHERE_API_KEY is not set');

  const res = await fetch(COHERE_EMBED_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'embed-english-v3.0',
      texts,
      input_type: inputType,
      embedding_types: ['float'],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Cohere embed failed: ${res.status} ${detail}`);
  }

  const data = await res.json();
  return data.embeddings.float; // array of vectors, same order as input texts
}

/**
 * embedText — embed a single string (used for the incoming user question).
 */
export async function embedQuery(env, text) {
  const [vector] = await callCohereEmbed(env, [text], 'search_query');
  return vector;
}

/**
 * embedDocuments — embed many chunk texts at once (used when upserting chunks).
 * Cohere allows batching up to 96 texts per call, so we chunk the requests.
 */
export async function embedDocuments(env, texts) {
  const BATCH_SIZE = 96;
  const vectors = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchVectors = await callCohereEmbed(env, batch, 'search_document');
    vectors.push(...batchVectors);
  }

  return vectors;
}