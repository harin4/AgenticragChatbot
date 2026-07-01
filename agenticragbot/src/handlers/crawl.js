/**
 * Layer 1 crawl orchestrator — discover URLs, scrape via Jina, save to R2 + Neon.
 */
import { crawlSite } from '../services/crawler.js';
import { scrapeWithJina } from '../services/jina.js';
import { resolveManualUrls } from '../utils/url-list.js';
import {
  createJob,
  updateJob,
  getJob,
  saveDocument,
  docExistsByUrl,
} from '../services/db.js';
import { processDocument, saveGlobalMemoryIndexToR2 } from './processor.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve pages from POST /crawl body. */
export async function resolveCrawlPages(body, env) {
  const maxPages = Math.min(parseInt(body.maxPages || '50', 10) || 50, 200);

  if (Array.isArray(body.urls) && body.urls.length > 0) {
    return resolveManualUrls(body.urls, maxPages);
  }

  const startUrl = body.url?.trim();
  if (!startUrl) {
    throw new Error('Provide "url" for auto-crawl or "urls" array for manual list');
  }

  return crawlSite(startUrl, maxPages, env);
}

/**
 * Background crawl job. Call via ctx.waitUntil() from POST /crawl.
 */
export async function runCrawlJob(env, jobId, body) {
  const skipExisting = body.skipExisting !== false;
  const processAfter = Boolean(body.processAfter);
  const jinaDelayMs = Math.max(parseInt(body.jinaDelayMs || '500', 10) || 500, 0);
  const start = Date.now();

  let pages = [];
  let docsSaved = 0;
  let docsSkipped = 0;
  let errors = 0;
  let lastError = null;

  try {
    pages = await resolveCrawlPages(body, env);
    await updateJob(env, jobId, { status: 'running', pagesFound: pages.length });

    for (const page of pages) {
      try {
        if (skipExisting && await docExistsByUrl(env, page.url)) {
          docsSkipped++;
          await updateJob(env, jobId, { docsSkipped, pagesFound: pages.length });
          continue;
        }

        const scraped = await scrapeWithJina(page.url, env);
        const docId = crypto.randomUUID();

        await saveDocument(env, {
          id: docId,
          jobId,
          url: page.url,
          title: scraped.title || page.title || '',
          description: scraped.description || '',
          markdownContent: scraped.markdown,
          charCount: scraped.markdown.length,
          wordCount: scraped.wordCount,
        });

        docsSaved++;
        await updateJob(env, jobId, { docsSaved, pagesFound: pages.length });

        if (processAfter) {
          await processDocument(env, docId);
        }

        if (jinaDelayMs > 0) await sleep(jinaDelayMs);
      } catch (err) {
        errors++;
        lastError = err.message;
        console.error(`[crawl] ${page.url}:`, err.message);
        await updateJob(env, jobId, { errors, errorDetail: lastError });
      }
    }

    if (processAfter && docsSaved > 0) {
      await saveGlobalMemoryIndexToR2(env);
    }

    await updateJob(env, jobId, {
      status: 'completed',
      docsSaved,
      docsSkipped,
      errors,
      pagesFound: pages.length,
      durationMs: Date.now() - start,
      completedAt: new Date().toISOString(),
      errorDetail: errors > 0 ? lastError : null,
    });
  } catch (err) {
    await updateJob(env, jobId, {
      status: 'failed',
      errors: errors + 1,
      durationMs: Date.now() - start,
      completedAt: new Date().toISOString(),
      errorDetail: err.message,
    });
    throw err;
  }

  return { jobId, pagesFound: pages.length, docsSaved, docsSkipped, errors };
}

/** Start crawl — returns jobId immediately; caller should waitUntil(runCrawlJob). */
export async function startCrawlJob(env, body) {
  const jobId = crypto.randomUUID();
  const seedUrl = body.url?.trim()
    || (Array.isArray(body.urls) && body.urls[0]
      ? (typeof body.urls[0] === 'string' ? body.urls[0] : body.urls[0].url)
      : 'manual-list');
  const maxPages = Math.min(parseInt(body.maxPages || '50', 10) || 50, 200);

  await createJob(env, { jobId, url: seedUrl, maxPages });
  return { jobId, seedUrl, maxPages };
}

export async function getCrawlJobStatus(env, jobId) {
  const job = await getJob(env, jobId);
  if (!job) return null;
  return {
    jobId: job.id,
    url: job.url,
    status: job.status,
    maxPages: job.max_pages,
    pagesFound: job.pages_found,
    docsSaved: job.docs_saved,
    docsSkipped: job.docs_skipped,
    errors: job.errors,
    errorDetail: job.error_detail,
    durationMs: job.duration_ms,
    docsCount: job.docs_count,
    createdAt: job.created_at,
    completedAt: job.completed_at,
    lastDocAt: job.last_doc_at,
  };
}
