/**
 * features/langchain-agent/server/index.js
 * ──────────────────────────────────────────────────────────────────────────
 * Standalone server for the agentic query/answer feature. Runs alongside
 * the existing KB processor (server.js, port 3001) on its own port so the
 * ingestion pipeline is untouched — this feature only reads what's already
 * in Neon/Qdrant.
 */

import express from 'express';
import cors from 'cors';
import { loadEnv } from './lib/env.js';
import { createAskRouter } from './routes/ask.js';

const env = loadEnv();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/api', createAskRouter(env));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'MergeX Agentic RAG (LangChain.js)',
    endpoints: { ask: 'POST /api/ask' },
  });
});

const server = app.listen(env.AGENT_PORT, () => {
  console.log(`\n✓ LangChain agent API running on port ${env.AGENT_PORT}`);
  console.log(`  POST /api/ask`);
  console.log(`  GET  /health\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗ Port ${env.AGENT_PORT} is already in use.`);
    console.error(`  Set a different port: AGENT_PORT=3003 node features/langchain-agent/server/index.js\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

export default app;
