/**
 * End-to-end smoke test for the KB Processor API.
 * Runs offline checks first, then starts server.js and hits HTTP routes.
 * DB-backed checks use a transaction that is always rolled back.
 *
 * Usage: node scripts/dev/run-e2e-test.js
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Client } from '@neondatabase/serverless';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');
const PORT = parseInt(process.env.E2E_PORT || '3099', 10);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✅ ${label}`);
  passed++;
}

function fail(label, err) {
  console.error(`  ❌ ${label}: ${err?.message || err}`);
  failed++;
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

async function runHttpTests() {
  console.log('\n[e2e] HTTP route tests...');

  const health = await fetch(`${BASE}/health`);
  if (!health.ok) throw new Error(`/health returned ${health.status}`);
  const healthBody = await health.json();
  if (healthBody.status !== 'ok') throw new Error('health status not ok');
  ok('GET /health');

  const raw = await fetch(`${BASE}/process/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      markdown: '# Hello\n\nSome body text for chunking.',
      docId: 'e2e-test',
    }),
  });
  if (!raw.ok) throw new Error(`/process/raw returned ${raw.status}: ${await raw.text()}`);
  const rawBody = await raw.json();
  if (!rawBody.chunks?.length) throw new Error('/process/raw produced no chunks');
  ok('POST /process/raw (JSON body parsing)');

  const memoryIndex = await fetch(`${BASE}/memory-index`);
  if (!memoryIndex.ok) throw new Error(`/memory-index returned ${memoryIndex.status}: ${await memoryIndex.text()}`);
  const indexBody = await memoryIndex.json();
  if (typeof indexBody.docCount !== 'number') throw new Error('/memory-index missing docCount');
  ok('GET /memory-index');

  const batch = await fetch(`${BASE}/process/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docIds: ['nonexistent-doc-id'] }),
  });
  if (!batch.ok) throw new Error(`/process/batch returned ${batch.status}`);
  const batchBody = await batch.json();
  if (!batchBody.errors?.length) throw new Error('/process/batch should report missing doc');
  ok('POST /process/batch (JSON body parsing)');
}

async function runDbTransactionTest() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('\n[e2e] Skipping DB transaction test (no DATABASE_URL)');
    return;
  }

  console.log('\n[e2e] DB transaction test (rolled back)...');
  const client = new Client({ connectionString: url });
  const env = { DATABASE_URL: url, dbClient: client };

  await client.connect();
  await client.query('BEGIN');

  try {
    const { cleanAndChunkMarkdown } = await import('../../src/pipeline/index.js');
    const { saveChunks, saveChunkMemory, getChunksByDocId, buildMemoryIndexFromDB } =
      await import('../../src/chunk-db.js');

    const docId = `e2e-${Date.now()}`;
    const markdown = `---
title: "E2E Test"
source_url: "https://example.com/e2e"
---

# Machine Learning

E2E test paragraph about machine learning concepts.
`;

    await client.query(`
      INSERT INTO kb_documents (id, url, title, markdown_content, char_count, word_count)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [docId, `https://example.com/e2e/${docId}`, 'E2E Test', markdown, markdown.length, 10]);

    const memoryIndex = await buildMemoryIndexFromDB(env);
    const { chunks } = await cleanAndChunkMarkdown(markdown, docId, memoryIndex);
    if (!chunks.length) throw new Error('pipeline produced no chunks for test doc');

    await saveChunks(env, chunks);
    await saveChunkMemory(env, docId, { version: '1.1.0', docId, chunks });

    const saved = await getChunksByDocId(env, docId);
    if (saved.length !== chunks.length) {
      throw new Error(`expected ${chunks.length} saved chunks, got ${saved.length}`);
    }
    ok('DB pipeline save + read (transaction)');
  } catch (err) {
    fail('DB pipeline save + read (transaction)', err);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
    console.log('[e2e] DB transaction rolled back');
  }
}

async function main() {
  console.log('[e2e] Starting end-to-end tests...');

  // Re-run fixtures inline as first gate
  const { execSync } = await import('child_process');
  try {
    execSync('node scripts/dev/run-fixtures-test.js', { cwd: ROOT, stdio: 'pipe' });
    ok('fixture suite (inline)');
  } catch (err) {
    fail('fixture suite (inline)', err);
  }

  await runDbTransactionTest();

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  try {
    await waitForHealth();
    ok(`server started on port ${PORT}`);
    await runHttpTests();
  } catch (err) {
    fail('HTTP tests', err);
    if (serverLog) console.error('\n--- server log ---\n' + serverLog);
  } finally {
    server.kill();
  }

  console.log(`\n[e2e] Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('[e2e] Fatal:', err);
  process.exit(1);
});
