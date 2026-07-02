/**
 * features/langchain-agent/server/tools/searchTool.js
 * ──────────────────────────────────────────────────────────────────────────
 * The "agentic" piece (Step 3): a LangChain StructuredTool the LLM decides
 * to call, as many or as few times as it wants, instead of the server always
 * stuffing chunks into the prompt up front.
 *
 * `retrieved` is a Map<chunkId, chunk> passed in by the caller (see
 * agent/pass1.js). Every chunk this tool hydrates from Neon gets recorded
 * there so the orchestrator can later: (a) list real sources in the API
 * response, and (b) walk related_ids for the Pass 2 expansion — without the
 * tool itself needing to know anything about passes or confidence.
 */

import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { vectorSearch } from '../lib/vectorstore.js';
import { getChunkById } from '../lib/chunkStore.js';

const MAX_SNIPPET_CHARS = 900;

export function createSearchTool(env, embeddings, retrieved) {
  return tool(
    async ({ query, topK }) => {
      const hits = await vectorSearch(env, embeddings, query, topK || 4);
      if (hits.length === 0) {
        return 'No matching chunks found in the MergeX knowledge base for this query.';
      }

      const found = [];
      for (const hit of hits) {
        const chunk = await getChunkById(env, hit.chunkId);
        if (!chunk) continue;
        if (!retrieved.has(chunk.id)) {
          retrieved.set(chunk.id, { ...chunk, _score: hit.score, _via: 'search_tool' });
        }
        found.push(chunk);
      }

      if (found.length === 0) {
        return 'No matching chunks found in the MergeX knowledge base for this query.';
      }

      return found
        .map(
          (c, i) =>
            `[${c.id}] (${(c.heading_path || []).join(' > ')})\n${(c.text || '').slice(0, MAX_SNIPPET_CHARS)}`
        )
        .join('\n\n---\n\n');
    },
    {
      name: 'search_mergex_knowledge',
      description:
        'Search the MergeX knowledge base for chunks relevant to a query. Call this ' +
        'whenever you need facts about MergeX (the company, its methodology, services, ' +
        'etc.) to answer the user — do not answer from memory. You may call it more than ' +
        'once with different phrasings if the first search does not cover the question.',
      schema: z.object({
        query: z.string().describe('A focused search query capturing what information is needed'),
        topK: z.number().int().min(1).max(8).optional().describe('How many chunks to retrieve (default 4)'),
      }),
    }
  );
}
