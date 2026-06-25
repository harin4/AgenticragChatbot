/**
 * scripts/init-db.js
 * Run this ONCE to create tables in your Neon database.
 *
 * Usage:
 *   export DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"
 *   node scripts/init-db.js
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌  Set DATABASE_URL environment variable first.');
  console.error('    export DATABASE_URL="postgresql://..."');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

async function init() {
  console.log('🔧  Initializing Neon database schema...\n');

  await sql`
    CREATE TABLE IF NOT EXISTS kb_jobs (
      id           TEXT PRIMARY KEY,
      url          TEXT NOT NULL,
      max_pages    INTEGER DEFAULT 50,
      status       TEXT DEFAULT 'running',
      pages_found  INTEGER DEFAULT 0,
      docs_saved   INTEGER DEFAULT 0,
      error        TEXT,
      duration_ms  INTEGER,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;
  console.log('✅  Table: kb_jobs');

  await sql`
    CREATE TABLE IF NOT EXISTS kb_documents (
      id          TEXT PRIMARY KEY,
      job_id      TEXT REFERENCES kb_jobs(id),
      url         TEXT NOT NULL,
      title       TEXT,
      r2_key      TEXT NOT NULL,
      char_count  INTEGER DEFAULT 0,
      saved_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  console.log('✅  Table: kb_documents');

  await sql`CREATE INDEX IF NOT EXISTS idx_kb_docs_job ON kb_documents(job_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_kb_docs_url ON kb_documents(url)`;
  console.log('✅  Indexes created');

  console.log('\n🎉  Schema ready. Your Neon DB is set up.');
}

init().catch(err => {
  console.error('❌  Schema init failed:', err.message);
  process.exit(1);
});