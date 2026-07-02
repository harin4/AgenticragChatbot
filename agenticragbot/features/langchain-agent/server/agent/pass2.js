/**
 * features/langchain-agent/server/agent/pass2.js
 * ──────────────────────────────────────────────────────────────────────────
 * Second half of Step 4 — only runs when Pass 1 reports confident=false.
 *
 * Pulls in the `related_ids` cross-doc links already built by the KB
 * pipeline (src/pipeline/chunk.js + the back-fill pass in server.js) for
 * every chunk Pass 1 already retrieved, so the model gets connected context
 * from OTHER docs on the same topic without doing another vector search.
 * Then asks once more with the widened context — no tool loop this time,
 * the context is handed directly since we already know what's relevant.
 */

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { getChunkById } from '../lib/chunkStore.js';

const SYSTEM_PROMPT = `You are a knowledgeable assistant answering questions about MergeX, using only the provided context.

Cite sources inline using their chunk id in square brackets, e.g. [docId#slug]. If the context still does not fully answer the question, say so plainly rather than guessing.`;

/**
 * @param {object} params
 * @param {object} params.env
 * @param {import('@langchain/groq').ChatGroq} params.chatModel
 * @param {string} params.question
 * @param {Map<string,object>} params.retrieved - chunks already found in Pass 1 (mutated in place with expansion)
 * @returns {Promise<{answer: string, expandedChunkIds: string[]}>}
 */
export async function runPass2({ env, chatModel, question, retrieved }) {
  const alreadyHave = new Set(retrieved.keys());
  const relatedIds = new Set();

  for (const chunk of retrieved.values()) {
    for (const relId of chunk.related_ids || []) {
      if (!alreadyHave.has(relId)) relatedIds.add(relId);
    }
  }

  const expandedChunkIds = [];
  for (const relId of relatedIds) {
    const chunk = await getChunkById(env, relId);
    if (chunk && !retrieved.has(chunk.id)) {
      retrieved.set(chunk.id, { ...chunk, _score: 0, _via: 'related_id (pass 2)' });
      expandedChunkIds.push(chunk.id);
    }
  }

  const context = [...retrieved.values()]
    .map((c) => `[${c.id}] (${(c.heading_path || []).join(' > ')})\n${c.text}`)
    .join('\n\n---\n\n');

  const response = await chatModel.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(`Context:\n\n${context}\n\nQuestion: ${question}`),
  ]);

  return { answer: response.content, expandedChunkIds };
}
