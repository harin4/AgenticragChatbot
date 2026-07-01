/**
 * Sync Layer 1 + Layer 1.5 schema directly on the database in DATABASE_URL.
 * Use before npm run test:staging on a fresh Neon staging branch.
 *
 * Usage:
 *   $env:DATABASE_URL="postgresql://..."
 *   npm run staging:sync-schema
 */
import dotenv from 'dotenv';
import { initSchema } from '../../src/services/db.js';
import { initChunkSchema } from '../../src/chunk-db.js';

dotenv.config();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[sync-schema] ❌ DATABASE_URL is not set.');
  process.exit(1);
}

const PROD_HOST = 'ep-holy-surf-att7koby-pooler';
if (url.includes(PROD_HOST)) {
  console.error('[sync-schema] ❌ ABORT: DATABASE_URL points to production.');
  process.exit(1);
}

if (!/^postgres(ql)?:\/\/.+@.+\/.+/.test(url)) {
  console.error('[sync-schema] ❌ DATABASE_URL is not a valid Postgres connection string.');
  process.exit(1);
}

const env = { DATABASE_URL: url };

console.log('[sync-schema] Initializing Layer 1 tables (kb_jobs, kb_documents)...');
const layer1 = await initSchema(env);
console.log('[sync-schema] ✅', layer1.tables?.join(', ') || 'Layer 1 ready');

console.log('[sync-schema] Initializing Layer 1.5 tables (kb_chunks, kb_chunk_memory)...');
const layer15 = await initChunkSchema(env);
console.log('[sync-schema] ✅', layer15.tables?.join(', ') || 'Layer 1.5 ready');

console.log('\n[sync-schema] Done. Run: npm run test:staging');
