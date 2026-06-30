/**
 * src/services/groq.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Thin client for Groq's chat completions endpoint. Groq's API is
 * OpenAI-compatible, so a plain fetch call is enough — no SDK dependency
 * needed for just this.
 *
 * Models (check https://console.groq.com/docs/models for the current list —
 * Groq deprecates/renames fast):
 *   llama-3.3-70b-versatile   — good default, strong reasoning
 *   llama-3.1-8b-instant      — much faster, fine for simple Q&A
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

/**
 * askGroq
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} opts - { model, temperature, maxTokens }
 * @returns {Promise<{answer: string, usage: object, model: string}>}
 */
export async function askGroq(systemPrompt, userPrompt, opts = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GROQ_API_KEY is not set. Add it to .env — get a free key at https://console.groq.com/keys'
    );
  }

  const model = opts.model || DEFAULT_MODEL;

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 700,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    answer: data.choices?.[0]?.message?.content ?? '',
    usage: data.usage || null,
    model,
  };
}