/**
 * features/langchain-agent/server/routes/ask.js
 * POST /api/ask — the one endpoint the React UI (Step 5) talks to.
 */

import { Router } from 'express';
import { answerQuestion } from '../agent/index.js';

export function createAskRouter(env) {
  const router = Router();

  router.post('/ask', async (req, res) => {
    const { question } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'question field required (string)' });
    }

    try {
      const result = await answerQuestion(env, question.trim());
      res.json(result);
    } catch (err) {
      console.error('[agent/ask] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
