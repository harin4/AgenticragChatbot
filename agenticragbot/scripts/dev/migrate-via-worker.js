/**
 * Run full R2 migration via the Cloudflare Worker API.
 *
 * Prerequisites:
 *   1. R2 bucket: npx wrangler r2 bucket create kb-storage
 *   2. Worker running: npm run worker:dev   (or deployed URL)
 *   3. DATABASE_URL in .dev.vars
 *
 * Usage:
 *   npm run migrate:r2
 *   WORKER_URL=https://kb-formation.xxx.workers.dev npm run migrate:r2
 *   npm run migrate:r2 -- --sync-only
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.dev.vars' });
dotenv.config();

const WORKER_URL = (process.env.WORKER_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const syncOnly = process.argv.includes('--sync-only');
const skipProcess = process.argv.includes('--skip-process') || syncOnly;

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
  console.log(`[migrate:r2] Worker: ${WORKER_URL}`);

  const health = await api('/health');
  console.log(`[migrate:r2] Health: ${health.status} (${health.runtime})`);

  if (syncOnly) {
    const sync = await api('/sync/r2/batch', {
      method: 'POST',
      body: JSON.stringify({ clearNeon: true }),
    });
    console.log(JSON.stringify(sync, null, 2));
    return;
  }

  const result = await api('/migrate/r2', {
    method: 'POST',
    body: JSON.stringify({ clearNeon: true, skipProcess, rescrapeMissing: true }),
  });

  console.log('\n[migrate:r2] Migration complete:\n');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('[migrate:r2] FAILED:', err.message);
  console.error(`
If worker is not running:
  npm run worker:dev

If R2 bucket missing:
  npx wrangler r2 bucket create kb-storage
`);
  process.exit(1);
});
