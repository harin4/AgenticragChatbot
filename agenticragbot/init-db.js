/**
 * scripts/init-db.js
 * Run ONCE to create tables in your Neon database.
 *
 * WHY THIS SCHEMA:
 *   kb_jobs        — tracks every crawl/ingest run: how many pages found,
 *                    saved, skipped, errored, and total duration. This gives
 *                    you an audit trail and lets the admin panel poll job
 *                    progress without reading kb_documents.
 *
 *   kb_documents   — stores the full cleaned markdown content directly in
 *                    Postgres (TEXT column). Why not R2?
 *                    (1) Neon free tier = 0.5 GB, plenty for a KB of ~500 pages
 *                        averaging 5–10 KB each (2.5–5 MB total).
 *                    (2) One store = one query, no pre-signed URL round-trip.
 *                    (3) Full-text search and ILIKE queries work natively on
 *                        the column — impossible with R2 objects.
 *                    Migrate content to R2 only when you approach 400 MB.
 *
 *   markdown_content is NOT NULL — if Jina returns nothing meaningful, the
 *   row is never inserted (quality gate in index.js checks char_count >= 200).
 *
 *   url UNIQUE constraint — re-crawling the same page UPSERTs (updates) the
 *   content rather than creating duplicates. The KB stays idempotent.
 *
 * Usage:
 *   export DATABASE_URL="postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require"
 *   node scripts/init-db.js
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌  Set DATABASE_URL environment variable first.');
  console.error('    export DATABASE_URL="postgresql://..."');
  console.error('    Use the POOLER endpoint from Neon dashboard, not the direct URL.');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

async function init() {
  console.log('🔧  Initializing Neon database schema...\n');

  // ── kb_jobs: one row per crawl/ingest job ──────────────────────────────────
  // docs_skipped: pages skipped because they already exist (skipExisting=true)
  //               or were too short after Jina scrape
  // errors:       pages that threw during Jina fetch or DB save
  // error_detail: last fatal error message (if status = 'failed')
  await sql`
    CREATE TABLE IF NOT EXISTS kb_jobs (
      id            TEXT        PRIMARY KEY,
      url           TEXT        NOT NULL,
      max_pages     INTEGER     DEFAULT 50,
      status        TEXT        DEFAULT 'running',
      pages_found   INTEGER     DEFAULT 0,
      docs_saved    INTEGER     DEFAULT 0,
      docs_skipped  INTEGER     DEFAULT 0,
      errors        INTEGER     DEFAULT 0,
      error_detail  TEXT,
      duration_ms   INTEGER,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      completed_at  TIMESTAMPTZ
    )
  `;
  console.log('✅  Table: kb_jobs');

  // ── kb_documents: one row per page, markdown stored inline ────────────────
  // markdown_content TEXT NOT NULL — the full Jina-cleaned markdown with YAML
  //   front matter (title, source_url, scraped_at, word_count, description).
  //   This format feeds directly into the AI chunker (Layer 2) without any
  //   transformation: chunker reads the front matter for metadata and the body
  //   for content splitting.
  //
  // word_count — stored denormalized so Layer 2 can filter "too short" chunks
  //   without loading the full content.
  //
  // url UNIQUE — enforces idempotency. POST /crawl with skipExisting=false
  //   will UPDATE the row rather than duplicate it.
  await sql`
    CREATE TABLE IF NOT EXISTS kb_documents (
      id               TEXT        PRIMARY KEY,
      job_id           TEXT        REFERENCES kb_jobs(id) ON DELETE SET NULL,
      url              TEXT        NOT NULL UNIQUE,
      title            TEXT,
      description      TEXT,
      markdown_content TEXT        NOT NULL,
      char_count       INTEGER     DEFAULT 0,
      word_count       INTEGER     DEFAULT 0,
      scraped_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  console.log('✅  Table: kb_documents');

  // ── Indexes ────────────────────────────────────────────────────────────────
  // job index    — fast lookup of "all docs for job X" (used by /kb/list?jobId=)
  // url index    — fast EXISTS check before each Jina scrape (skipExisting path)
  // scraped_at   — default sort for /kb/list (most recently scraped first)
  await sql`CREATE INDEX IF NOT EXISTS idx_kb_docs_job   ON kb_documents(job_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_kb_docs_url   ON kb_documents(url)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_kb_docs_saved ON kb_documents(scraped_at DESC)`;
  console.log('✅  Indexes created');

  console.log('\n🎉  Schema ready. Neon DB is set up.');
  console.log('\nNext steps:');
  console.log('  1. wrangler secret put JINA_API_KEY');
  console.log('  2. wrangler secret put DATABASE_URL  (use the pooler URL)');
  console.log('  3. wrangler deploy');
  console.log('  4. POST /crawl  { "url": "https://yoursite.com", "maxPages": 50 }');
  console.log('     or POST /crawl  { "urls": ["https://yoursite.com/page1", ...] }');
}

init().catch(err => {
  console.error('❌  Schema init failed:', err.message);
  process.exit(1);
});