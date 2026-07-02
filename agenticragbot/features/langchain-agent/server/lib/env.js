/**
 * features/langchain-agent/server/lib/env.js
 * ──────────────────────────────────────────────────────────────────────────
 * Loads the SAME .env used by the root server.js (one project, one set of
 * secrets) and validates the keys this feature needs before anything else
 * runs, so a missing key fails fast with a clear message instead of a vague
 * 401 three calls deep into an agent loop.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = path.resolve(__dirname, '../../../../.env');

dotenv.config({ path: ROOT_ENV });

const REQUIRED = [
  'GROQ_API_KEY',
  'COHERE_API_KEY',
  'QDRANT_URL',
  'QDRANT_API_KEY',
  'DATABASE_URL',
];

export function loadEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}. Add them to ${ROOT_ENV}`
    );
  }

  return {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_MODEL: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    COHERE_API_KEY: process.env.COHERE_API_KEY,
    QDRANT_URL: process.env.QDRANT_URL,
    QDRANT_API_KEY: process.env.QDRANT_API_KEY,
    QDRANT_COLLECTION: process.env.QDRANT_COLLECTION || 'mergex_chunks',
    DATABASE_URL: process.env.DATABASE_URL,
    AGENT_PORT: parseInt(process.env.AGENT_PORT || '3002'),
  };
}
