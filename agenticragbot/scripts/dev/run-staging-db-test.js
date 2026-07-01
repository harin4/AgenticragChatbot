import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Client } from '@neondatabase/serverless';

import { cleanAndChunkMarkdown } from '../../src/pipeline/index.js';
import { buildMemoryIndex, saveMemoryMdFiles } from '../../src/pipeline/memory.js';
import {
  saveChunks,
  saveChunkMemory,
  getAllChunkMemories,
  buildMemoryIndexFromDB,
  updateChunkRelatedIds,
  getChunksByDocId
} from '../../src/chunk-db.js';
import { normalizeTitle } from '../../src/pipeline/chunk.js';

if (fs.existsSync('.env.test')) {
  dotenv.config({ path: '.env.test' });
} else {
  dotenv.config();
}

// 1. Guardrail: Protect Production Database
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[test:staging] ❌ DATABASE_URL is not set.');
  process.exit(1);
}

const PROD_HOST = 'ep-holy-surf-att7koby-pooler';
if (url.includes(PROD_HOST)) {
  console.error('[test:staging] ❌ ABORT: DATABASE_URL points to the production database.');
  console.error('Switch your .env to a Neon staging branch URL before running this test.');
  process.exit(1);
}

if (!/^postgres(ql)?:\/\/.+@.+\/.+/.test(url)) {
  console.error('[test:staging] ❌ DATABASE_URL does not look like a valid Postgres connection string.');
  console.error('Use a real Neon staging branch URL from the dashboard — not a placeholder like postgresql://...staging...');
  process.exit(1);
}

// 2. Setup tmpdir for memory files
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-memory-test-'));
process.env.MEMORY_DIR = tmpDir; // override memory.js

const client = new Client({ connectionString: url });
const env = { DATABASE_URL: url, dbClient: client }; // dbClient forces reuse

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, '../../tests/graph-fixtures');

async function runStagingTest() {
  console.log(`[test:staging] Running stateful tests on staging DB...`);
  console.log(`[test:staging] Temp memory dir: ${tmpDir}`);

  try {
    await client.connect();
  } catch (err) {
    console.error('[test:staging] ❌ Could not connect to database.');
    console.error('Check DATABASE_URL — use a Neon staging branch pooler URL with ?sslmode=require');
    console.error(err.message || err);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }
  
  // Transaction begin
  await client.query('BEGIN');

  let docAChunks = [];
  let docBChunks = [];

  try {
    // Read fixtures
    const rawA = fs.readFileSync(path.join(fixturesDir, 'doc-a.md'), 'utf8');
    const rawB = fs.readFileSync(path.join(fixturesDir, 'doc-b.md'), 'utf8');

    // --- Process Doc A ---
    console.log('[test:staging] Processing Doc A...');
    const indexA = await buildMemoryIndexFromDB(env);
    const resultA = await cleanAndChunkMarkdown(rawA, 'doc-a', indexA);
    docAChunks = resultA.chunks;

    await saveChunks(env, docAChunks);
    await saveChunkMemory(env, 'doc-a', { version: '1.1.0', docId: 'doc-a', chunks: docAChunks });
    saveMemoryMdFiles('doc-a', { docId: 'doc-a', chunks: docAChunks }, docAChunks, indexA);

    // --- Process Doc B ---
    console.log('[test:staging] Processing Doc B...');
    const indexB = await buildMemoryIndexFromDB(env);
    const resultB = await cleanAndChunkMarkdown(rawB, 'doc-b', indexB);
    docBChunks = resultB.chunks;

    await saveChunks(env, docBChunks);
    await saveChunkMemory(env, 'doc-b', { version: '1.1.0', docId: 'doc-b', chunks: docBChunks });
    saveMemoryMdFiles('doc-b', { docId: 'doc-b', chunks: docBChunks }, docBChunks, indexB);

    // --- Backfill Doc A ---
    console.log('[test:staging] Running backfill...');
    const newDocIndex = {};
    for (const c of docBChunks) {
      for (const title of (c.heading_path || [])) {
        const key = normalizeTitle(title);
        if (!newDocIndex[key]) newDocIndex[key] = [];
        newDocIndex[key].push(c.id);
      }
    }
    
    let updated = 0;
    for (const aChunk of docAChunks) {
      const headingPath = aChunk.heading_path || [];
      const newRelatedIds = [];
      for (const title of headingPath) {
         const key = normalizeTitle(title);
         const matches = (newDocIndex[key] || []).filter(id => !newRelatedIds.includes(id));
         newRelatedIds.push(...matches);
      }
      if (newRelatedIds.length > 0) {
         const merged = [...new Set([...(aChunk.related_ids || []), ...newRelatedIds])];
         await updateChunkRelatedIds(env, aChunk.id, merged);
         updated++;
      }
    }
    console.log(`[test:staging] Backfilled ${updated} chunks in Doc A`);

    // --- Assertions ---
    console.log('[test:staging] Running assertions...');
    
    const savedB = await getChunksByDocId(env, 'doc-b');
    const docBTargetChunk = savedB.find(c => c.heading_path.some(h => h.toLowerCase().includes('machine learning')));
    if (!docBTargetChunk) throw new Error('Could not find doc-b chunk');
    
    // In javascript JSON parsing from pg driver is automatic for JSONB columns?
    // Note: Neon Client usually parses JSONB automatically.
    const relatedB = typeof docBTargetChunk.related_ids === 'string' ? JSON.parse(docBTargetChunk.related_ids) : docBTargetChunk.related_ids;
    if (!relatedB.includes(docAChunks[0].id)) {
       throw new Error(`doc-b did not link to doc-a. Related ids: ${JSON.stringify(relatedB)}`);
    }

    const savedA = await getChunksByDocId(env, 'doc-a');
    const relatedA = typeof savedA[0].related_ids === 'string' ? JSON.parse(savedA[0].related_ids) : savedA[0].related_ids;
    if (!relatedA.includes(docBTargetChunk.id)) {
       throw new Error('doc-a was not backfilled with doc-b link');
    }

    const titleA = normalizeTitle('Machine Learning');
    const titleB = normalizeTitle('machine learning');
    if (titleA !== titleB) {
       throw new Error('normalizeTitle did not match casing differences');
    }

    console.log('[test:staging] ✅ All integration tests passed.');
  } catch (err) {
    console.error('[test:staging] ❌ Test Failed:', err);
    process.exitCode = 1;
  } finally {
    console.log('[test:staging] Rolling back transaction (clean state)...');
    
    // Call ROLLBACK using the stateful client
    await client.query('ROLLBACK');
    await client.end();

    // Remove tmpDir
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('[test:staging] Temp dir deleted.');
  }
}

runStagingTest().catch(err => {
  console.error('[test:staging] ❌ Unhandled error:', err.message || err);
  process.exit(1);
});
