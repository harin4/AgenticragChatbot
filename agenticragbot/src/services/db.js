/**
 * src/db.js
 * All Neon (serverless Postgres) operations for KB Formation — Layer 1.
 */

/**
 * KNOWN LIMITATION — Hyperdrive not yet implemented.
 * Current: Client over WebSocket, ~3000ms per request (includes Neon
 * cold-start). Future optimization: switch to pg driver + Hyperdrive
 * for ~300-500ms. Requires Cloudflare dashboard config + driver swap.
 * Deferred pending lead sign-off.
 */
import { Client } from '@neondatabase/serverless';
import {
  hasR2,
  isR2Primary,
  buildRawDocR2Key,
  buildCleanedR2Key,
  buildMemoryR2Key,
  buildChunksJsonR2Key,
  saveToR2,
  getFromR2,
  deleteFromR2,
} from './storage.js';

// ─── DB client factory ────────────────────────────────────────────────────────
// Single-request lifecycle for Client. If a route provides env.dbClient, we
// reuse it (critical for transactions). Otherwise, we open and close it here.
export async function withClient(env, callback) {
  if (env.dbClient) return callback(env.dbClient);

  const url = env.DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Add it with: wrangler secret put DATABASE_URL');
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

// ─── Schema init (POST /init) ─────────────────────────────────────────────────

export async function initSchema(env) {
  return withClient(env, async (client) => {
    await client.query(`
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
    `);

    await client.query(`
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
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_kb_docs_job   ON kb_documents(job_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kb_docs_url   ON kb_documents(url)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kb_docs_saved ON kb_documents(scraped_at DESC)`);

    await client.query(`ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS r2_key TEXT`);
    await client.query(`ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS cleaned_r2_key TEXT`);
    await client.query(`ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS memory_r2_key TEXT`);
    await client.query(`ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS chunks_json_r2_key TEXT`);

    return {
      initialized: true,
      tables: ['kb_jobs', 'kb_documents'],
      storage: hasR2(env)
        ? (isR2Primary(env)
          ? 'R2-primary: markdown blobs in KB_BUCKET, Neon stores metadata + r2_key pointers'
          : 'dual-write: R2 + markdown_content in Neon')
        : 'markdown_content in Neon (bind KB_BUCKET R2 for cloud storage)',
      message: 'Schema ready.',
    };
  });
}

// ─── Create job ───────────────────────────────────────────────────────────────

export async function createJob(env, { jobId, url, maxPages }) {
  return withClient(env, async (client) => {
    await client.query(`
      INSERT INTO kb_jobs (id, url, max_pages, status, created_at)
      VALUES ($1, $2, $3, 'running', NOW())
      ON CONFLICT (id) DO NOTHING
    `, [jobId, url, maxPages]);
  });
}

// ─── Update job (safe dynamic UPDATE) ────────────────────────────────────────

export async function updateJob(env, jobId, updates) {
  return withClient(env, async (client) => {
    await client.query('BEGIN');
    try {
      if (updates.status) {
        await client.query(`UPDATE kb_jobs SET status = $1 WHERE id = $2`, [updates.status, jobId]);
      }
      if (updates.pagesFound !== undefined) {
        await client.query(`UPDATE kb_jobs SET pages_found = $1 WHERE id = $2`, [updates.pagesFound, jobId]);
      }
      if (updates.docsSaved !== undefined) {
        await client.query(`UPDATE kb_jobs SET docs_saved = $1 WHERE id = $2`, [updates.docsSaved, jobId]);
      }
      if (updates.docsSkipped !== undefined) {
        await client.query(`UPDATE kb_jobs SET docs_skipped = $1 WHERE id = $2`, [updates.docsSkipped, jobId]);
      }
      if (updates.errors !== undefined) {
        await client.query(`UPDATE kb_jobs SET errors = $1 WHERE id = $2`, [updates.errors, jobId]);
      }
      if (updates.errorDetail !== undefined) {
        await client.query(`UPDATE kb_jobs SET error_detail = $1 WHERE id = $2`, [updates.errorDetail, jobId]);
      }
      if (updates.durationMs !== undefined) {
        await client.query(`UPDATE kb_jobs SET duration_ms = $1 WHERE id = $2`, [updates.durationMs, jobId]);
      }
      if (updates.completedAt !== undefined) {
        await client.query(`UPDATE kb_jobs SET completed_at = $1 WHERE id = $2`, [updates.completedAt, jobId]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

// ─── Save document ────────────────────────────────────────────────────────────

export async function saveDocument(env, doc) {
  let r2Key = doc.r2Key || null;

  if (hasR2(env) && doc.markdownContent && doc.url) {
    r2Key = buildRawDocR2Key(doc.url, doc.id);
    await saveToR2(env, r2Key, doc.markdownContent, {
      url: doc.url,
      title: doc.title || '',
      docId: doc.id,
      jobId: doc.jobId || '',
      type: 'raw',
    });
  }

  return withClient(env, async (client) => {
    const neonMarkdown = (hasR2(env) && r2Key && isR2Primary(env))
      ? ''
      : doc.markdownContent;

    await client.query(`
      INSERT INTO kb_documents (
        id, job_id, url, title, description,
        markdown_content, char_count, word_count, r2_key,
        scraped_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW()
      )
      ON CONFLICT (url) DO UPDATE SET
        title            = EXCLUDED.title,
        description      = EXCLUDED.description,
        markdown_content = CASE
          WHEN EXCLUDED.r2_key IS NOT NULL AND $10 = true THEN ''
          ELSE EXCLUDED.markdown_content
        END,
        char_count       = EXCLUDED.char_count,
        word_count       = EXCLUDED.word_count,
        r2_key           = COALESCE(EXCLUDED.r2_key, kb_documents.r2_key),
        updated_at       = NOW()
    `, [
      doc.id,
      doc.jobId,
      doc.url,
      doc.title || null,
      doc.description || null,
      neonMarkdown,
      doc.charCount || 0,
      doc.wordCount || 0,
      r2Key,
      isR2Primary(env),
    ]);
    return r2Key;
  });
}

export async function updateDocR2Keys(env, docId, {
  cleanedR2Key,
  memoryR2Key,
  chunksJsonR2Key,
} = {}) {
  return withClient(env, async (client) => {
    if (cleanedR2Key) {
      await client.query(
        `UPDATE kb_documents SET cleaned_r2_key = $1, updated_at = NOW() WHERE id = $2`,
        [cleanedR2Key, docId]
      );
    }
    if (memoryR2Key) {
      await client.query(
        `UPDATE kb_documents SET memory_r2_key = $1, updated_at = NOW() WHERE id = $2`,
        [memoryR2Key, docId]
      );
    }
    if (chunksJsonR2Key) {
      await client.query(
        `UPDATE kb_documents SET chunks_json_r2_key = $1, updated_at = NOW() WHERE id = $2`,
        [chunksJsonR2Key, docId]
      );
    }
  });
}

// ─── Get job (with live doc count) ───────────────────────────────────────────

export async function getJob(env, jobId) {
  return withClient(env, async (client) => {
    const res = await client.query(`
      SELECT
        j.*,
        COUNT(d.id)::integer AS docs_count,
        MAX(d.scraped_at)    AS last_doc_at
      FROM kb_jobs j
      LEFT JOIN kb_documents d ON d.job_id = j.id
      WHERE j.id = $1
      GROUP BY j.id
    `, [jobId]);
    return res.rows[0] || null;
  });
}

// ─── Get document by ID ───────────────────────────────────────────────────────

export async function getDocById(env, docId) {
  const row = await withClient(env, async (client) => {
    const res = await client.query(`
      SELECT id, job_id, url, title, description,
             markdown_content, char_count, word_count,
             r2_key, cleaned_r2_key, memory_r2_key, chunks_json_r2_key,
             scraped_at, updated_at
      FROM kb_documents
      WHERE id = $1
      LIMIT 1
    `, [docId]);
    return res.rows[0] || null;
  });

  if (!row) return null;

  if (row.r2_key && hasR2(env)) {
    const obj = await getFromR2(env, row.r2_key);
    if (obj?.content) {
      row.markdown_content = obj.content;
    } else if (!row.markdown_content?.trim()) {
      throw new Error(
        `R2 object missing for r2_key=${row.r2_key} (doc ${docId}). ` +
        'Run POST /migrate/r2 with rescrapeMissing:true to recover from source URL.'
      );
    }
  }

  return row;
}

// ─── List documents (metadata only) ──────────────────────────────────────────

export async function listDocs(env, limit = 200, jobId = null) {
  return withClient(env, async (client) => {
    const cols = `id, job_id, url, title, description, char_count, word_count,
                  r2_key, cleaned_r2_key, memory_r2_key, chunks_json_r2_key, scraped_at`;
    if (jobId) {
      const res = await client.query(`
        SELECT ${cols}
        FROM kb_documents
        WHERE job_id = $1
        ORDER BY scraped_at DESC
        LIMIT $2
      `, [jobId, limit]);
      return res.rows;
    }
    const res = await client.query(`
      SELECT ${cols}
      FROM kb_documents
      ORDER BY scraped_at DESC
      LIMIT $1
    `, [limit]);
    return res.rows;
  });
}

// ─── Check URL existence (skipExisting gate) ──────────────────────────────────

export async function docExistsByUrl(env, url) {
  return withClient(env, async (client) => {
    const res = await client.query(`SELECT 1 FROM kb_documents WHERE url = $1 LIMIT 1`, [url]);
    return res.rows.length > 0;
  });
}

// ─── Delete document ──────────────────────────────────────────────────────────

export async function deleteDoc(env, docId) {
  const doc = await withClient(env, async (client) => {
    const res = await client.query(
      `SELECT r2_key, cleaned_r2_key, memory_r2_key, chunks_json_r2_key
       FROM kb_documents WHERE id = $1`,
      [docId]
    );
    return res.rows[0] || null;
  });

  if (doc && hasR2(env)) {
    const keys = [
      doc.r2_key,
      doc.cleaned_r2_key,
      doc.memory_r2_key,
      doc.chunks_json_r2_key,
    ].filter(Boolean);
    for (const key of keys) {
      await deleteFromR2(env, key);
    }
  }

  return withClient(env, async (client) => {
    await client.query(`DELETE FROM kb_chunk_memory WHERE id = $1`, [docId]);
    await client.query(`DELETE FROM kb_chunks WHERE doc_id = $1`, [docId]);
    await client.query(`DELETE FROM kb_documents WHERE id = $1`, [docId]);
  });
}

export async function syncDocMarkdownToR2(env, docId, { clearNeon = false, rescrapeIfMissing = false } = {}) {
  const doc = await withClient(env, async (client) => {
    const res = await client.query(
      `SELECT id, url, title, job_id, markdown_content, r2_key FROM kb_documents WHERE id = $1`,
      [docId]
    );
    return res.rows[0] || null;
  });

  if (!doc) throw new Error('Document not found');
  if (!hasR2(env)) throw new Error('KB_BUCKET R2 binding not configured');

  let markdown = doc.markdown_content?.trim() || '';
  if (!markdown && doc.r2_key) {
    const existing = await getFromR2(env, doc.r2_key);
    if (existing?.content) {
      return { docId, r2Key: doc.r2_key, chars: existing.content.length, alreadyInR2: true };
    }
    if (rescrapeIfMissing && doc.url) {
      const { scrapeWithJina } = await import('./jina.js');
      const scraped = await scrapeWithJina(doc.url, env);
      markdown = scraped.markdown;
    } else {
      throw new Error(
        `Document has no markdown in Neon or R2 (r2_key=${doc.r2_key}). ` +
        'Re-run with rescrapeIfMissing:true or POST /crawl to re-ingest.'
      );
    }
  }
  if (!markdown) throw new Error('Document has no markdown content');

  const r2Key = buildRawDocR2Key(doc.url, doc.id);
  await saveToR2(env, r2Key, markdown, {
    url: doc.url,
    title: doc.title || '',
    docId: doc.id,
    jobId: doc.job_id || '',
    type: 'raw',
  });

  const shouldClearNeon = clearNeon || isR2Primary(env);
  await withClient(env, async (client) => {
    await client.query(
      `UPDATE kb_documents
       SET r2_key = $1,
           markdown_content = CASE WHEN $3 = true THEN '' ELSE markdown_content END,
           updated_at = NOW()
       WHERE id = $2`,
      [r2Key, docId, shouldClearNeon]
    );
  });

  return { docId, r2Key, chars: markdown.length, clearedNeon: shouldClearNeon };
}

export async function syncAllDocsMarkdownToR2(env, { clearNeon = false, docIds = null, rescrapeIfMissing = false } = {}) {
  const ids = await withClient(env, async (client) => {
    if (Array.isArray(docIds) && docIds.length > 0) {
      return docIds;
    }
    const res = await client.query(
      `SELECT id FROM kb_documents ORDER BY scraped_at DESC`
    );
    return res.rows.map(r => r.id);
  });

  const results = [];
  const errors = [];

  for (const id of ids) {
    try {
      const out = await syncDocMarkdownToR2(env, id, { clearNeon, rescrapeIfMissing });
      results.push(out);
    } catch (err) {
      errors.push({ docId: id, error: err.message });
    }
  }

  return { synced: results.length, failed: errors.length, results, errors };
}

export async function getDocsR2Status(env) {
  return withClient(env, async (client) => {
    const res = await client.query(`
      SELECT
        COUNT(*)::integer AS total,
        COUNT(r2_key) FILTER (WHERE r2_key IS NOT NULL AND r2_key != '')::integer AS raw_in_r2,
        COUNT(cleaned_r2_key) FILTER (WHERE cleaned_r2_key IS NOT NULL)::integer AS cleaned_in_r2,
        COUNT(memory_r2_key) FILTER (WHERE memory_r2_key IS NOT NULL)::integer AS memory_in_r2,
        COUNT(*) FILTER (WHERE markdown_content IS NOT NULL AND markdown_content != '')::integer AS neon_markdown_remaining
      FROM kb_documents
    `);
    return res.rows[0];
  });
}

export async function searchDocs(env, query, limit = 20) {
  return withClient(env, async (client) => {
    const pattern = `%${query}%`;
    const res = await client.query(`
      SELECT id, job_id, url, title, description, char_count, word_count, scraped_at
      FROM kb_documents
      WHERE title ILIKE $1 OR description ILIKE $1
      ORDER BY scraped_at DESC
      LIMIT $2
    `, [pattern, limit]);
    return res.rows;
  });
}