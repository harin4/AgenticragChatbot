/**
 * features/langchain-agent/server/agent/pass1.js
 * ──────────────────────────────────────────────────────────────────────────
 * Step 3 + first half of Step 4.
 *
 * The LLM is handed the `search_mergex_knowledge` tool and decides for
 * itself whether/how many times to call it (agentic retrieval, as opposed to
 * the old /ask route which always retrieved N chunks up front). Once it
 * stops calling the tool (or a step cap is hit as a safety net against
 * runaway loops), one final structured-output call asks it to commit to an
 * answer AND self-report confidence — that confidence flag is what Step 4
 * uses to decide whether Pass 2 needs to run at all.
 */

import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { createSearchTool } from '../tools/searchTool.js';

const MAX_TOOL_STEPS = 4;

const SYSTEM_PROMPT = `You are a knowledgeable assistant answering questions about MergeX, using only the MergeX knowledge base.

You have a tool called search_mergex_knowledge. Use it to look up information before answering — never answer from general knowledge or guesses about MergeX specifically. You may call it more than once if the first results don't fully cover the question (e.g. try a rephrased query). Stop calling it once you have enough to answer, or once it's clear the knowledge base doesn't cover this.

When you finally answer:
- Ground every claim in the retrieved chunks. Cite them inline using their chunk id in square brackets, e.g. [docId#slug].
- If the retrieved chunks only partially answer the question, say what's missing rather than guessing.
- Set confident=false if the retrieved chunks feel incomplete, only tangentially related, or you suspect related/connected content elsewhere in the knowledge base would make the answer better. Set confident=true only when the chunks you found directly and fully answer the question.`;

const AnswerSchema = z.object({
  answer: z
    .string()
    .describe('The answer to the user question, grounded only in retrieved MergeX knowledge-base content, with inline [chunk_id] citations.'),
  confident: z
    .boolean()
    .describe('true only if the retrieved chunks fully and directly support the answer; false if the answer feels incomplete or under-supported.'),
  citedChunkIds: z
    .array(z.string())
    .describe('IDs of the chunks actually used to build the answer, from the search results (format "<docId>#<slug>").'),
});

/**
 * @returns {Promise<{answer:string, confident:boolean, citedChunkIds:string[], retrieved: Map<string,object>, toolCallLog: {query:string, resultCount:number}[], noContext: boolean}>}
 */
export async function runPass1({ env, chatModel, embeddings, question }) {
  const retrieved = new Map();
  const searchTool = createSearchTool(env, embeddings, retrieved);
  const modelWithTools = chatModel.bindTools([searchTool]);

  const messages = [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(question)];
  const toolCallLog = [];

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const response = await modelWithTools.invoke(messages);
    messages.push(response);

    const calls = response.tool_calls || [];
    if (calls.length === 0) break;

    for (const call of calls) {
      const sizeBefore = retrieved.size;
      const toolMessage = await searchTool.invoke(call);
      messages.push(toolMessage);
      toolCallLog.push({
        query: call.args?.query,
        resultCount: retrieved.size - sizeBefore,
      });
    }
  }

  if (retrieved.size === 0) {
    return {
      answer: "I don't have anything in the knowledge base that matches this question yet.",
      confident: true, // nothing more retrieval can add — no point running Pass 2
      citedChunkIds: [],
      retrieved,
      toolCallLog,
      noContext: true,
    };
  }

  const structuredModel = chatModel.withStructuredOutput(AnswerSchema, { name: 'final_answer' });

  const structured = await structuredModel.invoke([
    ...messages,
    new HumanMessage('Based on everything retrieved so far, give your final answer now.'),
  ]);

  return {
    answer: structured.answer,
    confident: structured.confident,
    citedChunkIds: structured.citedChunkIds || [],
    retrieved,
    toolCallLog,
    noContext: false,
  };
}
