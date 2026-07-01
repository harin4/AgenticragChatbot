/**
 * Sync kb_documents markdown → R2 via Worker API (batch).
 *
 * Usage:
 *   npm run sync:r2              # all docs
 *   npm run sync:r2 -- <docId>   # one doc
 *
 * Env:
 *   WORKER_URL  default http://127.0.0.1:8787
 *   API_KEY     optional Bearer token (production Worker)
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.dev.vars' });
dotenv.config();

const WORKER_URL = (process.env.WORKER_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const singleDocId = process.argv[2] || null;

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const apiKey = process.env.API_KEY?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${WORKER_URL}${path}`, { ...options, headers });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${path} → ${res.status}: ${body.error || text}`);
  }
  return body;
}

async function main() {
  console.log(`[sync:r2] Worker: ${WORKER_URL}`);

  if (singleDocId) {
    const out = await api(`/sync/r2/${singleDocId}`, {
      method: 'POST',
      body: JSON.stringify({ clearNeon: true }),
    });
    console.log(`✅ ${singleDocId} → ${out.r2Key} (${out.chars} chars, clearedNeon=${out.clearedNeon})`);
    return;
  }

  const out = await api('/sync/r2/batch', {
    method: 'POST',
    body: JSON.stringify({ clearNeon: true }),
  });

  console.log(`Synced: ${out.synced}, failed: ${out.failed}`);
  for (const r of out.results || []) {
    console.log(`  ✅ ${r.docId} → ${r.r2Key}`);
  }
  for (const e of out.errors || []) {
    console.error(`  ❌ ${e.docId}: ${e.error}`);
  }
}

main().catch((err) => {
  console.error('[sync:r2] FAILED:', err.message);
  console.error('Start worker first: npm run worker:dev');
  process.exit(1);
});
