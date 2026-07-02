/**
 * features/langchain-agent/server/agent/index.js
 * ──────────────────────────────────────────────────────────────────────────
 * Orchestrates Step 3 (agentic tool-calling retrieval) + Step 4 (two-pass
 * confidence gate) into one call the /api/ask route can use.
 *
 * Pass 2 only runs when Pass 1 says it isn't confident — keeping the common
 * case (confident on the first try) to a single retrieval + one LLM call,
 * same as the spec asks for.
 */

import { createChatModel } from '../lib/llm.js';
import { createEmbeddings } from '../lib/embeddings.js';
import { runPass1 } from './pass1.js';
import { runPass2 } from './pass2.js';

function toSourceList(retrieved) {
  return [...retrieved.values()].map((c) => ({
    id: c.id,
    doc_id: c.doc_id,
    heading_path: c.heading_path,
    score: c._score ?? null,
    via: c._via,
  }));
}

export async function answerQuestion(env, question) {
  const chatModel = createChatModel(env);
  const embeddings = createEmbeddings(env);

  const pass1 = await runPass1({ env, chatModel, embeddings, question });

  const base = {
    question,
    answer: pass1.answer,
    confident: pass1.confident,
    pass2Triggered: false,
    citedChunkIds: pass1.citedChunkIds,
    sources: toSourceList(pass1.retrieved),
    toolCalls: pass1.toolCallLog,
  };

  if (pass1.noContext || pass1.confident) {
    return base;
  }

  const pass2 = await runPass2({ env, chatModel, question, retrieved: pass1.retrieved });

  return {
    ...base,
    answer: pass2.answer,
    pass2Triggered: true,
    expandedChunkIds: pass2.expandedChunkIds,
    sources: toSourceList(pass1.retrieved), // pass1.retrieved was mutated in place with the expansion
  };
}
