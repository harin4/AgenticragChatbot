/**
 * src/index.js — KB Formation Worker, Layer 1
 *
 * Ingests web pages into a Neon knowledge base:
 *   Mode A (auto):   POST /crawl { url, maxPages? }         → crawls site via sitemap/links
 *   Mode B (manual): POST /crawl { urls: [...], maxPages? }  → ingests exact URL list
 *
 * WHY TWO MODES:
 *   Jina AI Reader works at the page level — it fetches and cleans one URL at
 *   a time. Sitemap discovery (Mode A) is best for well-structured sites with
 *   valid XML sitemaps. For sites with poor sitemaps, SPA routes, or when you
 *   want surgical control over which pages enter the KB (e.g. docs only, not
 *   blog), Mode B lets you POST an exact JSON array of URLs. No file hosting,
 *   no extra tooling — the crawl request IS the URL list.
 *
 * STORAGE DECISION — WHY NEON, NOT R2:
 *   Markdown content is stored as TEXT in kb_documents.markdown_content.
 *   At typical KB scale (<500 pages, ~5–10 KB each), this is:
 *   - Simpler: one store, one query, no pre-signed URL management
 *   - Faster: single INSERT saves everything; single SELECT returns everything
 *   - Searchable: ILIKE/full-text works on TEXT columns, impossible on R2 objects
 *   Migrate to R2 when content approaches 400 MB. storage.js is kept for that.
 *
 * Routes:
 *   POST   /crawl            { url, maxPages?, skipExisting? }              → auto-crawl job
 *   POST   /crawl            { urls: [...], maxPages?, skipExisting? }      → manual URL list job
 *   GET    /jobs/:id         → job status + doc count
 *   GET    /kb/list          → all documents (metadata, no content)
 *   GET    /kb/doc/:id       → single document WITH markdown content
 *   DELETE /kb/doc/:id       → delete document from Neon
 *   GET    /kb/search?q=     → keyword search on title/description
 *   POST   /init             → create DB tables (run once)
 *   GET    /health           → health check
 *
 * BUGS FIXED:
 *   #1  — wrangler.toml main = "src/index.js" (was "index.js")
 *   #2  — Import from './utils.js' (was 'util.js')
 *   #3  — deleteR2Document() removed; deleteDoc() used directly (no R2)
 *   #4  — updateJob() called with correct key names (pagesFound, docsSaved, docsSkipped)
 *   #6  — handleGetDoc uses getDocById() — O(1) PK lookup
 *   #7  — handleDelete uses getDocById() — O(1) PK lookup
 *   #12 — saveDocument() to Neon instead of saveToR2() to R2
 *   NEW — Manual URL list mode via `urls` array in POST /crawl body
 */

import { crawlSite }         from './crawler.js';
import { resolveManualUrls } from './url-list.js';
import { scrapeWithJina }    from './jina.js';
import {
  initSchema,
  createJob,
  updateJob,
  saveDocument,
  getJob,
  getDocById,
  listDocs,
  deleteDoc,
  docExistsByUrl,
  searchDocs,
} from './db.js';
import { corsHeaders, jsonResponse, errorResponse } from './utils.js';

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/crawl'     && request.method === 'POST')  return await handleCrawl(request, env, ctx);
      if (path === '/init'      && request.method === 'POST')  return jsonResponse(await initSchema(env));
      if (path === '/kb/list'   && request.method === 'GET')   return await handleList(url, env);
      if (path === '/kb/search' && request.method === 'GET')   return await handleSearch(url, env);

      if (path.startsWith('/jobs/')   && request.method === 'GET')    return await handleJobStatus(path.replace('/jobs/', ''), env);
      if (path.startsWith('/kb/doc/') && request.method === 'GET')    return await handleGetDoc(path.replace('/kb/doc/', ''), env);
      if (path.startsWith('/kb/doc/') && request.method === 'DELETE') return await handleDelete(path.replace('/kb/doc/', ''), env);

      if (path === '/' || path === '/health') {
        return jsonResponse({
          status:    'ok',
          service:   'KB Formation Worker — Layer 1',
          version:   '1.2.0',
          storage:   'Neon DB — markdown_content as TEXT in kb_documents',
          modes: {
            auto:   'POST /crawl { "url": "https://yoursite.com", "maxPages": 50 }',
            manual: 'POST /crawl { "urls": ["https://yoursite.com/page1", "..."] }',
          },
          timestamp: new Date().toISOString(),
        });
      }

      return errorResponse('Route not found', 404);

    } catch (err) {
      console.error('[worker] Unhandled error:', err);
      return errorResponse(err.message || 'Internal server error', 500);
    }
  },
};

// ─── POST /crawl ──────────────────────────────────────────────────────────────
// Accepts two modes:
//   { url: string }               → auto-crawl via sitemap/link discovery
//   { urls: string[] | object[] } → manual URL list (exact pages to ingest)

async function handleCrawl(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('Request body must be valid JSON', 400);

  const skipExisting = body.skipExisting !== false; // default true
  const maxPages     = Math.min(parseInt(body.maxPages) || 50, 500);

  // ── Mode B: manual URL list ────────────────────────────────────────────────
  if (Array.isArray(body.urls)) {
    let pages;
    try {
      pages = resolveManualUrls(body.urls, maxPages);
    } catch (err) {
      return errorResponse(err.message, 400);
    }

    const jobId = crypto.randomUUID();
    // Use the origin of the first URL as the job's representative URL
    const representativeUrl = pages[0]?.url || 'manual-list';
    await createJob(env, { jobId, url: representativeUrl, maxPages: pages.length });

    ctx.waitUntil(
      runIngestJob(jobId, pages, skipExisting, env).catch(async (err) => {
        console.error(`[job ${jobId}] Fatal:`, err.message);
        await updateJob(env, jobId, {
          status:      'failed',
          errorDetail: err.message,
          completedAt: new Date().toISOString(),
        }).catch(() => {});
      })
    );

    return jsonResponse({
      jobId,
      mode:         'manual',
      message:      'Manual URL list job started. Poll statusUrl to track progress.',
      statusUrl:    `/jobs/${jobId}`,
      urlCount:     pages.length,
      skipExisting,
      preview:      pages.slice(0, 5).map(p => p.url),
    }, 202);
  }

  // ── Mode A: auto-crawl ─────────────────────────────────────────────────────
  if (!body.url) {
    return errorResponse(
      'Missing required field. Use either:\n' +
      '  { "url": "https://yoursite.com" }  for auto-crawl\n' +
      '  { "urls": ["https://..."] }        for manual URL list',
      400
    );
  }

  const targetUrl = body.url.trim();
  try { new URL(targetUrl); } catch {
    return errorResponse('Invalid URL format', 400);
  }

  const jobId = crypto.randomUUID();
  await createJob(env, { jobId, url: targetUrl, maxPages });

  ctx.waitUntil(
    runAutoCrawlJob(jobId, targetUrl, maxPages, skipExisting, env).catch(async (err) => {
      console.error(`[job ${jobId}] Fatal:`, err.message);
      await updateJob(env, jobId, {
        status:      'failed',
        errorDetail: err.message,
        completedAt: new Date().toISOString(),
      }).catch(() => {});
    })
  );

  return jsonResponse({
    jobId,
    mode:         'auto',
    message:      'Auto-crawl job started. Poll statusUrl to track progress.',
    statusUrl:    `/jobs/${jobId}`,
    url:          targetUrl,
    maxPages,
    skipExisting,
  }, 202);
}

// ─── GET /jobs/:id ────────────────────────────────────────────────────────────

async function handleJobStatus(jobId, env) {
  if (!jobId) return errorResponse('Missing job ID', 400);
  const job = await getJob(env, jobId);
  if (!job) return errorResponse('Job not found', 404);
  return jsonResponse(job);
}

// ─── GET /kb/list ─────────────────────────────────────────────────────────────

async function handleList(url, env) {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '200'), 500);
  const jobId = url.searchParams.get('jobId') || null;
  const docs  = await listDocs(env, limit, jobId);
  return jsonResponse({ count: docs.length, documents: docs });
}

// ─── GET /kb/search?q= ────────────────────────────────────────────────────────

async function handleSearch(url, env) {
  const q = url.searchParams.get('q') || '';
  if (!q.trim()) return errorResponse('Missing query param: q', 400);
  const docs = await searchDocs(env, q.trim(), 20);
  return jsonResponse({ count: docs.length, query: q, documents: docs });
}

// ─── GET /kb/doc/:id ─────────────────────────────────────────────────────────
// BUG FIXED #6: getDocById() — direct PK lookup, not full table scan

async function handleGetDoc(docId, env) {
  if (!docId) return errorResponse('Missing doc ID', 400);
  const doc = await getDocById(env, docId);
  if (!doc) return errorResponse('Document not found', 404);

  return jsonResponse({
    id:              doc.id,
    url:             doc.url,
    title:           doc.title,
    description:     doc.description,
    charCount:       doc.char_count,
    wordCount:       doc.word_count,
    scrapedAt:       doc.scraped_at,
    updatedAt:       doc.updated_at,
    // Full markdown with YAML front matter — feed directly into AI chunker (Layer 2)
    markdownContent: doc.markdown_content,
  });
}

// ─── DELETE /kb/doc/:id ───────────────────────────────────────────────────────
// BUG FIXED #7: getDocById() — direct PK lookup

async function handleDelete(docId, env) {
  if (!docId) return errorResponse('Missing doc ID', 400);
  const doc = await getDocById(env, docId);
  if (!doc) return errorResponse('Document not found', 404);

  await deleteDoc(env, docId);
  return jsonResponse({ deleted: true, docId, url: doc.url });
}

// ─── Auto-crawl job (Mode A) ──────────────────────────────────────────────────
// Discovers pages via sitemap / recursive link crawl, then ingests each one.

async function runAutoCrawlJob(jobId, targetUrl, maxPages, skipExisting, env) {
  console.log(`[job ${jobId}] Mode A (auto-crawl): ${targetUrl}  maxPages=${maxPages}`);

  const pages = await crawlSite(targetUrl, maxPages, env);
  console.log(`[job ${jobId}] Discovered ${pages.length} pages`);

  await updateJob(env, jobId, { pagesFound: pages.length, status: 'processing' });
  return runIngestJob(jobId, pages, skipExisting, env);
}

// ─── Core ingest loop (shared by both modes) ──────────────────────────────────
// Takes a pre-resolved list of { url, title, source } and ingests each one.

async function runIngestJob(jobId, pages, skipExisting, env) {
  const startTime = Date.now();
  const saved     = [];
  const skipped   = [];
  const errored   = [];

  // For manual mode, pagesFound isn't set yet
  await updateJob(env, jobId, { pagesFound: pages.length, status: 'processing' });

  for (const page of pages) {
    try {
      // Skip already-crawled URLs (idempotency guard)
      if (skipExisting && await docExistsByUrl(env, page.url)) {
        console.log(`[job ${jobId}] Skip (exists): ${page.url}`);
        skipped.push(page.url);
        continue;
      }

      // Fetch page content via Jina AI Reader → clean markdown
      const { markdown, title, description, wordCount } = await scrapeWithJina(page.url, env);

      // Quality gate: too-short content = skeleton/failure slipped through
      if (!markdown || markdown.length < 200) {
        console.warn(`[job ${jobId}] Skip (too short, ${markdown?.length ?? 0} chars): ${page.url}`);
        skipped.push(page.url);
        continue;
      }

      // Save to Neon kb_documents (markdown_content column)
      // BUG FIXED #12: saveDocument() to Neon, not saveToR2() to R2
      const docId = crypto.randomUUID();
      await saveDocument(env, {
        id:              docId,
        jobId,
        url:             page.url,
        title:           title || page.title || '',  // Jina title > manual hint > empty
        description:     description || '',
        markdownContent: markdown,
        charCount:       markdown.length,
        wordCount,
      });

      saved.push({ docId, url: page.url, chars: markdown.length, words: wordCount });
      console.log(`[job ${jobId}] ✓ Saved: ${page.url}  (${markdown.length} chars, ${wordCount} words)`);

    } catch (pageErr) {
      console.error(`[job ${jobId}] ✗ Failed: ${page.url} — ${pageErr.message}`);
      errored.push({ url: page.url, error: pageErr.message });
    }

    // Polite delay — avoids hammering Jina's rate limits
    // Free tier: 20 req/min → 3 000 ms minimum gap. Paid: 200 req/min → 300 ms.
    await sleep(300);
  }

  const durationMs = Date.now() - startTime;
  // BUG FIXED #4: all key names match updateJob() expectations exactly
  await updateJob(env, jobId, {
    status:      'completed',
    docsSaved:   saved.length,
    docsSkipped: skipped.length,
    errors:      errored.length,
    durationMs,
    completedAt: new Date().toISOString(),
  });

  console.log(
    `[job ${jobId}] Done. saved=${saved.length}  skipped=${skipped.length}  errors=${errored.length}  ${(durationMs / 1000).toFixed(1)}s`
  );

  return { saved, skipped, errored };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}