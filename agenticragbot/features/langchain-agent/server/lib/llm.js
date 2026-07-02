/**
 * features/langchain-agent/server/lib/llm.js
 * ──────────────────────────────────────────────────────────────────────────
 * LangChain's official Groq connector. Replaces the raw fetch() calls in
 * src/services/groq.js for this feature — same model, same Groq account,
 * now wired through @langchain/groq so it supports .bindTools() /
 * .withStructuredOutput() for the agentic pass.
 */

import { ChatGroq } from '@langchain/groq';

export function createChatModel(env, opts = {}) {
  return new ChatGroq({
    apiKey: env.GROQ_API_KEY,
    model: opts.model || env.GROQ_MODEL,
    temperature: opts.temperature ?? 0.2,
    maxTokens: opts.maxTokens ?? 800,
  });
}
