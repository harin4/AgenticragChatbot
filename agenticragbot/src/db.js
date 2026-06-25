/**
 * src/db.js
 * All Neon (serverless Postgres) operations for KB Formation — Layer 1.
 *
 * WHY NEON INSTEAD OF R2 FOR CONTENT STORAGE:
 *   At early stage (<500 pages, <50 KB each), storing markdown_content as a
 *   TEXT column in Postgres is strictly better than R2:
 *     - One round-trip: INSERT saves everything; SELECT returns everything.
 *     - Full-text search (ILIKE, tsvector) works on TEXT columns natively.
 *     - UPSERT on URL conflict is a single SQL statement — no object key management.
 *     - Neon free tier = 0.5 GB. 500 pages × 10 KB avg = 5 MB. You have headroom.
 *   When you approach 400 MB of content, move markdown_content to R2, keep
 *   the r2_key reference here, and update getDocById() to fetch from R2.
 *
 * WHY THE POOLER URL MATTERS:
 *   Cloudflare Workers are stateless and short-lived. Each Worker invocation
 *   opens a new connection. Using Neon's direct URL exhausts the 100-connection
 *   limit within seconds under any real load. The pooler (PgBouncer) multiplexes
 *   thousands of short-lived connections into a small number of real Postgres
 *   connections. Always use the pooler URL in DATABASE_URL.
 *
 * TABLES:
 *   kb_jobs      — crawl job tracking (status, page counts, timings)
 *   kb_documents — full markdown content + metadata per page
 *
 * BUGS FIXED (from original):
 *   #4  — updateJob() key names aligned with index.js (pagesFound, docsSaved, etc.)
 *   #5  — COALESCE with null::integer cast replaced with safe conditional UPDATE
 *   #6  — getDocById() for O(1) PK lookup (no full table scan)
 *   #8  — getDocById() implemented
 *   #12 — Storage changed from R2 to Neon markdown_content column
 *   #13 — kb_documents has markdown_content TEXT NOT NULL, no r2_key
 *   #14 — initSchema schema matches all columns in updateJob() + saveDocument()
 */

import { neon } from '@neondatabase/serverless';

// ─── DB client factory ────────────────────────────────────────────────────────
// Called per-request. neon() is lightweight — it creates an HTTP client, not a
// persistent TCP connection. Safe to call on every request in a Worker.

function getDb(env) {
  if (!env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Add it with: wrangler secret put DATABASE_URL\n' +
      'Use the Neon POOLER endpoint: postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require'
    );
  }
  return neon(env.DATABASE_URL);
}

// ─── Schema init (POST /init) ─────────────────────────────────────────────────
// Idempotent — safe to run multiple times. Used when deploying to a fresh Neon
// project. Prefer running scripts/init-db.js locally (shows better output).

export async function initSchema(env) {
  const sql = getDb(env);

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

  await sql`CREATE INDEX IF NOT EXISTS idx_kb_docs_job   ON kb_documents(job_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_kb_docs_url   ON kb_documents(url)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_kb_docs_saved ON kb_documents(scraped_at DESC)`;

  return {
    initialized: true,
    tables: ['kb_jobs', 'kb_documents'],
    storage: 'markdown_content stored as TEXT in Neon (no R2)',
    message: 'Schema ready. POST /crawl to start your first KB job.',
  };
}

// ─── Create job ───────────────────────────────────────────────────────────────

export async function createJob(env, { jobId, url, maxPages }) {
  const sql = getDb(env);
  await sql`
    INSERT INTO kb_jobs (id, url, max_pages, status, created_at)
    VALUES (${jobId}, ${url}, ${maxPages}, 'running', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

// ─── Update job (safe dynamic UPDATE) ────────────────────────────────────────
// BUG FIXED #4 + #5:
//   Original used COALESCE(null::integer) which crashes Neon's HTTP driver.
//   This version builds a parameterized query only from keys that are present,
//   so no nulls are ever cast to integer, and key names match index.js exactly.

export async function updateJob(env, jobId, updates = {}) {
  const sql = getDb(env);

  if (updates.status !== undefined) {
    await sql`
      UPDATE kb_jobs
      SET status = ${updates.status}
      WHERE id = ${jobId}
    `;
  }

  if (updates.pagesFound !== undefined) {
    await sql`
      UPDATE kb_jobs
      SET pages_found = ${updates.pagesFound}
      WHERE id = ${jobId}
    `;
  }

  if (updates.docsSaved !== undefined) {
    await sql`
      UPDATE kb_jobs
      SET docs_saved = ${updates.docsSaved}
      WHERE id = ${jobId}
    `;
  }

  if (updates.durationMs !== undefined) {
    await sql`
      UPDATE kb_jobs
      SET duration_ms = ${updates.durationMs}
      WHERE id = ${jobId}
    `;
  }

  if (updates.completedAt !== undefined) {
    await sql`
      UPDATE kb_jobs
      SET completed_at = ${updates.completedAt}
      WHERE id = ${jobId}
    `;
  }
}

// ─── Save document ────────────────────────────────────────────────────────────
// WHY UPSERT ON url:
//   Re-crawling the same page (e.g. after a content update) should refresh the
//   KB entry, not create a duplicate. ON CONFLICT (url) DO UPDATE ensures the
//   KB stays clean across multiple crawl runs.
//
// WHY markdown_content NOT NULL:
//   A document without content is useless to the AI chunker. The caller
//   (index.js) enforces a 200-char minimum before calling saveDocument(), so
//   this column constraint is a safety net, not the primary gate.

export async function saveDocument(env, doc) {
  const sql = getDb(env);

  await sql`
    INSERT INTO kb_documents (
      id, job_id, url, title, description,
      markdown_content, char_count, word_count,
      scraped_at, updated_at
    ) VALUES (
      ${doc.id},
      ${doc.jobId},
      ${doc.url},
      ${doc.title       || null},
      ${doc.description || null},
      ${doc.markdownContent},
      ${doc.charCount   || 0},
      ${doc.wordCount   || 0},
      NOW(),
      NOW()
    )
    ON CONFLICT (url) DO UPDATE SET
      title            = EXCLUDED.title,
      description      = EXCLUDED.description,
      markdown_content = EXCLUDED.markdown_content,
      char_count       = EXCLUDED.char_count,
      word_count       = EXCLUDED.word_count,
      updated_at       = NOW()
  `;
}

// ─── Get job (with live doc count) ───────────────────────────────────────────

export async function getJob(env, jobId) {
  const sql = getDb(env);
  const rows = await sql`
    SELECT
      j.*,
      COUNT(d.id)::integer AS docs_count,
      MAX(d.scraped_at)    AS last_doc_at
    FROM kb_jobs j
    LEFT JOIN kb_documents d ON d.job_id = j.id
    WHERE j.id = ${jobId}
    GROUP BY j.id
  `;
  return rows[0] || null;
}

// ─── Get document by ID ───────────────────────────────────────────────────────
// BUG FIXED #6 + #8:
//   Original code did a full table scan (SELECT * LIMIT 1 without WHERE id =).
//   This does a direct primary key lookup — O(1) regardless of table size.

export async function getDocById(env, docId) {
  const sql = getDb(env);
  const rows = await sql`
    SELECT id, job_id, url, title, description,
           markdown_content, char_count, word_count, scraped_at, updated_at
    FROM kb_documents
    WHERE id = ${docId}
    LIMIT 1
  `;
  return rows[0] || null;
}

// ─── List documents (metadata only) ──────────────────────────────────────────
// WHY no markdown_content here:
//   The list endpoint is for the admin panel overview. Returning full markdown
//   for 200 documents would be ~1–2 MB per response. Metadata-only keeps it
//   under 50 KB. Fetch /kb/doc/:id for full content when needed.

export async function listDocs(env, limit = 200, jobId = null) {
  const sql = getDb(env);

  if (jobId) {
    return sql`
      SELECT id, job_id, url, title, description, char_count, word_count, scraped_at
      FROM kb_documents
      WHERE job_id = ${jobId}
      ORDER BY scraped_at DESC
      LIMIT ${limit}
    `;
  }

  return sql`
    SELECT id, job_id, url, title, description, char_count, word_count, scraped_at
    FROM kb_documents
    ORDER BY scraped_at DESC
    LIMIT ${limit}
  `;
}

// ─── Check URL existence (skipExisting gate) ──────────────────────────────────

export async function docExistsByUrl(env, url) {
  const sql = getDb(env);
  const rows = await sql`SELECT 1 FROM kb_documents WHERE url = ${url} LIMIT 1`;
  return rows.length > 0;
}

// ─── Delete document ──────────────────────────────────────────────────────────

export async function deleteDoc(env, docId) {
  const sql = getDb(env);
  await sql`DELETE FROM kb_documents WHERE id = ${docId}`;
}

// ─── Keyword search (admin panel) ────────────────────────────────────────────
// ILIKE is case-insensitive prefix/contains search. Fast enough for <10K rows.
// For full semantic search, use the Qdrant vector DB in Layer 2.

export async function searchDocs(env, query, limit = 20) {
  const sql = getDb(env);
  const pattern = `%${query}%`;
  return sql`
    SELECT id, job_id, url, title, description, char_count, word_count, scraped_at
    FROM kb_documents
    WHERE title ILIKE ${pattern}
       OR description ILIKE ${pattern}
    ORDER BY scraped_at DESC
    LIMIT ${limit}
  `;
}