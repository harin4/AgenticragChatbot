import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { cleanAndChunkMarkdown } from './pipeline/index.js';
import { renderMemoryMd, renderGlobalMemoryIndex } from './pipeline/memory.js';
import {
  initChunkSchema,
  getChunksByDocId,
  getChunkById,
  deleteChunkCascade,
  getChunkMemory,
  getAllChunkMemories,
  buildMemoryIndexFromDB,
} from './chunk-db.js';
import { initSchema, syncDocMarkdownToR2, syncAllDocsMarkdownToR2, getDocsR2Status, listDocs, deleteDoc } from './services/db.js';
import { getFromR2, hasR2, isR2Primary, buildGlobalMemoryIndexR2Key } from './services/storage.js';
import {
  processDocument,
  memoryIndexResponse,
  saveGlobalMemoryIndexToR2,
} from './handlers/processor.js';
import {
  startCrawlJob,
  runCrawlJob,
  getCrawlJobStatus,
} from './handlers/crawl.js';

const app = new Hono();

app.onError((err, c) => {
  console.error('[Error]', err);
  return c.json({ error: err.message || 'Internal Server Error' }, 500);
});

app.use('*', cors());

// Auth: Bearer token in production only. LOCAL_DEV=true skips auth (wrangler dev --env dev).
app.use('*', async (c, next) => {
  const path = c.req.path;
  if (path === '/health' || path === '/') return next();
  if (c.env.LOCAL_DEV === 'true') return next();

  const expected = String(c.env.API_KEY ?? '').trim();
  if (!expected) return next();
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing Bearer Token' }, 401);
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (token !== expected) {
    return c.json({ error: 'Unauthorized: Invalid Token' }, 401);
  }
  await next();
});

app.get('/', (c) => c.text('Agentic RAG KB API — Cloudflare Worker. Visit /health for status.'));

app.get('/health', (c) => c.json({
  status: 'ok',
  runtime: 'cloudflare-worker',
  service: 'KB Processor — Layer 1 + 1.5',
  version: '1.3.0',
  auth: {
    required: c.env.LOCAL_DEV !== 'true' && Boolean(String(c.env.API_KEY ?? '').trim()),
    localDev: c.env.LOCAL_DEV === 'true',
    keyLength: c.env.API_KEY ? String(c.env.API_KEY).trim().length : 0,
  },
  memory: 'dynamic via GET /kb/memory/:file (R2-backed when KB_BUCKET bound)',
  storage: {
    r2Bound: 'check KB_BUCKET at runtime',
    r2Primary: 'R2_PRIMARY=true (markdown blobs in R2, Neon pointers only)',
  },
  endpoints: {
    crawl: 'POST /crawl',
    jobs: 'GET /jobs/:jobId',
    kb_list: 'GET /kb/list',
    init: 'POST /init',
    migrate: 'POST /migrate/r2',
    sync_r2_batch: 'POST /sync/r2/batch',
    process_single: 'POST /process/doc/:docId',
    process_batch: 'POST /process/batch',
    process_raw: 'POST /process/raw',
    memory_json: 'GET /memory/:docId',
    memory_index: 'GET /memory-index',
    memory_md: 'GET /kb/memory/:file',
    inspect: 'GET /inspect, GET /inspect/:docId',
    chunks: 'GET /chunks?docId=, GET /chunks/:id, DELETE /chunks/:id',
  },
}));

// ─── Layer 1: Crawl + ingest ─────────────────────────────────────────────────

app.post('/crawl', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    const { jobId, seedUrl, maxPages } = await startCrawlJob(c.env, body);
    c.executionCtx.waitUntil(runCrawlJob(c.env, jobId, body));
    return c.json({
      status: 'accepted',
      jobId,
      seedUrl,
      maxPages,
      poll: `/jobs/${jobId}`,
      message: 'Crawl running in background via waitUntil',
    }, 202);
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

app.get('/jobs/:jobId', async (c) => {
  try {
    const job = await getCrawlJobStatus(c.env, c.req.param('jobId'));
    if (!job) return c.json({ error: 'Job not found' }, 404);
    return c.json(job);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/kb/list', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '200', 10);
    const jobId = c.req.query('jobId') || null;
    const docs = await listDocs(c.env, limit, jobId);
    return c.json({ count: docs.length, docs });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.delete('/kb/doc/:docId', async (c) => {
  try {
    const docId = c.req.param('docId');
    await deleteDoc(c.env, docId);
    return c.json({ status: 'deleted', docId });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/init', async (c) => {
  try {
    const env = c.env;
    const layer1 = await initSchema(env);
    const layer15 = await initChunkSchema(env);
    return c.json({
      status: 'initialized',
      tables: [...(layer1.tables || []), ...(layer15.tables || [])],
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/process/doc/:docId', async (c) => {
  const docId = c.req.param('docId');
  try {
    const result = await processDocument(c.env, docId);
    if (result.error === 'not_found') {
      return c.json({ error: 'Document not found in KB' }, 404);
    }

    const { doc, chunks, alerts, memoryMap, backfillCount, crossLinks, r2Saved } = result;
    const globalIndexKey = await saveGlobalMemoryIndexToR2(c.env);

    return c.json({
      status: 'processed',
      docId,
      url: doc.url,
      title: doc.title,
      chunkCount: chunks.length,
      avgTokens: chunks.length
        ? Math.round(chunks.reduce((s, ch) => s + ch.token_count, 0) / chunks.length)
        : 0,
      crossLinks,
      alerts,
      savedChunks: chunks.length,
      backfilled: backfillCount,
      r2: r2Saved || null,
      globalMemoryIndexR2: globalIndexKey,
      memory: {
        docId,
        version: memoryMap.version,
        timestamp: memoryMap.timestamp,
        chunks: memoryMap.chunks.length,
        graphStats: memoryMap.graphStats,
      },
      memoryUrls: {
        markdown: `/kb/memory/${docId}.memory.md`,
        chunksJson: `/kb/memory/${docId}.chunks.json`,
        globalIndex: '/kb/memory/memory-index.md',
        rawMarkdown: `/kb/doc/${docId}`,
      },
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/process/batch', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { docIds } = body;
  if (!Array.isArray(docIds) || docIds.length === 0) {
    return c.json({ error: 'docIds must be a non-empty array' }, 400);
  }

  const results = [];
  const errors = [];

  for (const docId of docIds) {
    try {
      const result = await processDocument(c.env, docId);
      if (result.error === 'not_found') {
        errors.push({ docId, error: 'not found' });
        continue;
      }
      const { chunks, backfillCount, crossLinks } = result;
      results.push({
        docId,
        chunkCount: chunks.length,
        crossLinks,
        backfilled: backfillCount,
        status: 'ok',
      });
    } catch (err) {
      errors.push({ docId, error: err.message });
    }
  }

  const globalIndexKey = results.length ? await saveGlobalMemoryIndexToR2(c.env) : null;

  return c.json({
    status: 'batch-completed',
    processed: results.length,
    failed: errors.length,
    globalMemoryIndexR2: globalIndexKey,
    results,
    errors: errors.length ? errors : undefined,
  });
});

app.post('/process/raw', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { markdown, docId = 'test-doc' } = body;
  if (!markdown || typeof markdown !== 'string') {
    return c.json({ error: 'markdown field required (string)' }, 400);
  }

  try {
    const { cleaned, chunks, alerts } = await cleanAndChunkMarkdown(markdown, docId);
    return c.json({
      status: 'processed-raw',
      docId,
      cleaned: { lines: cleaned.lines.length, text: cleaned.markdown, stats: cleaned.stats },
      chunks,
      alerts,
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/memory-index', async (c) => {
  try {
    const memoryIndex = await buildMemoryIndexFromDB(c.env);
    return c.json(memoryIndexResponse(memoryIndex));
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/memory/:docId', async (c) => {
  try {
    const memory = await getChunkMemory(c.env, c.req.param('docId'));
    if (!memory) return c.json({ error: 'Memory map not found. Process doc first.' }, 404);
    return c.json(memory);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/chunks', async (c) => {
  const docId = c.req.query('docId');
  if (!docId) return c.json({ error: 'docId query param required' }, 400);
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  try {
    const chunks = await getChunksByDocId(c.env, docId, limit, offset);
    return c.json({ docId, count: chunks.length, data: chunks });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/chunks/:chunkId', async (c) => {
  try {
    const chunk = await getChunkById(c.env, c.req.param('chunkId'));
    if (!chunk) return c.json({ error: 'Chunk not found' }, 404);
    return c.json(chunk);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.delete('/chunks/:chunkId', async (c) => {
  try {
    const chunkId = c.req.param('chunkId');
    const docId = await deleteChunkCascade(c.env, chunkId);
    return c.json({ status: 'deleted', chunkId, docId });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/inspect', async (c) => {
  try {
    const { listDocs, getDocsR2Status } = await import('./services/db.js');
    const docs = await listDocs(c.env, 500);
    const r2Status = hasR2(c.env) ? await getDocsR2Status(c.env) : null;
    return c.json({
      docs,
      storage: {
        r2Bound: hasR2(c.env),
        r2Primary: isR2Primary(c.env),
        ...r2Status,
      },
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/inspect/:docId', async (c) => {
  const docId = c.req.param('docId');
  try {
    const { getDocById } = await import('./services/db.js');
    const doc = await getDocById(c.env, docId);
    if (!doc) return c.json({ error: 'Document not found' }, 404);

    const storedChunks = await getChunksByDocId(c.env, docId, 500, 0);
    const memoryIndex = await buildMemoryIndexFromDB(c.env);
    const { cleaned, chunks, alerts } = await cleanAndChunkMarkdown(
      doc.markdown_content,
      docId,
      memoryIndex
    );

    return c.json({
      doc,
      storedChunks,
      pipeline: { cleaned: { lines: cleaned.lines, markdown: cleaned.markdown, stats: cleaned.stats }, chunks, alerts },
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/kb/cleaned/:docId', async (c) => {
  const docId = c.req.param('docId');
  const env = c.env;
  try {
    const { withClient } = await import('./services/db.js');
    const row = await withClient(env, async (client) => {
      const res = await client.query(
        `SELECT cleaned_r2_key FROM kb_documents WHERE id = $1`,
        [docId]
      );
      return res.rows[0] || null;
    });
    if (!row?.cleaned_r2_key) {
      return c.json({ error: 'Cleaned markdown not in R2. Run POST /process/doc/:docId first.' }, 404);
    }
    const obj = await getFromR2(env, row.cleaned_r2_key);
    if (!obj?.content) {
      return c.json({ error: 'R2 object missing', key: row.cleaned_r2_key }, 404);
    }
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('X-R2-Key', row.cleaned_r2_key);
    return c.text(obj.content);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/kb/doc/:docId', async (c) => {
  const docId = c.req.param('docId');
  const env = c.env;
  try {
    const { getDocById } = await import('./services/db.js');
    const doc = await getDocById(env, docId);
    if (!doc) return c.json({ error: 'Document not found' }, 404);

    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('X-R2-Key', doc.r2_key || '');
    return c.text(doc.markdown_content || '');
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

/** Upload existing Neon markdown_content → R2 and set r2_key (one-time backfill). */
app.post('/sync/r2/:docId', async (c) => {
  try {
    let clearNeon = false;
    try {
      const body = await c.req.json();
      clearNeon = Boolean(body?.clearNeon);
    } catch {
      // no body is fine
    }
    const result = await syncDocMarkdownToR2(c.env, c.req.param('docId'), { clearNeon });
    return c.json({ status: 'synced', ...result });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

/** Batch backfill: copy all (or listed) docs from Neon → R2. */
app.post('/sync/r2/batch', async (c) => {
  if (!hasR2(c.env)) {
    return c.json({ error: 'KB_BUCKET R2 binding not configured' }, 503);
  }

  let body = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body → sync all
  }

  try {
    const result = await syncAllDocsMarkdownToR2(c.env, {
      clearNeon: Boolean(body.clearNeon),
      docIds: body.docIds,
    });
    return c.json({ status: 'batch-synced', ...result });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

/**
 * Full R2 migration: schema init → sync raw markdown → process all → global memory index.
 * Body: { docIds?, clearNeon?, skipProcess? }
 */
app.post('/migrate/r2', async (c) => {
  if (!hasR2(c.env)) {
    return c.json({ error: 'KB_BUCKET R2 binding not configured. Create bucket and bind KB_BUCKET in wrangler.toml.' }, 503);
  }

  let body = {};
  try {
    body = await c.req.json();
  } catch {
    // defaults
  }

  const steps = [];

  try {
    const layer1 = await initSchema(c.env);
    const layer15 = await initChunkSchema(c.env);
    steps.push({ step: 'init', ok: true, tables: [...(layer1.tables || []), ...(layer15.tables || [])] });

    const syncResult = await syncAllDocsMarkdownToR2(c.env, {
      clearNeon: body.clearNeon !== false,
      docIds: body.docIds,
      rescrapeIfMissing: body.rescrapeMissing !== false,
    });
    steps.push({ step: 'sync_raw_to_r2', ...syncResult });

    let processResult = { skipped: true };
    if (!body.skipProcess) {
      const { listDocs } = await import('./services/db.js');
      const docs = body.docIds?.length
        ? body.docIds.map(id => ({ id }))
        : await listDocs(c.env, 500);
      const processed = [];
      const processErrors = [];

      for (const doc of docs) {
        try {
          const result = await processDocument(c.env, doc.id);
          if (result.error === 'not_found') {
            processErrors.push({ docId: doc.id, error: 'not found' });
            continue;
          }
          processed.push({ docId: doc.id, chunkCount: result.chunks.length });
        } catch (err) {
          processErrors.push({ docId: doc.id, error: err.message });
        }
      }

      const globalIndexKey = await saveGlobalMemoryIndexToR2(c.env);
      processResult = {
        processed: processed.length,
        failed: processErrors.length,
        results: processed,
        errors: processErrors.length ? processErrors : undefined,
        globalMemoryIndexR2: globalIndexKey,
      };
    }
    steps.push({ step: 'process_docs', ...processResult });

    const r2Status = await getDocsR2Status(c.env);
    steps.push({ step: 'status', ...r2Status });

    return c.json({
      status: 'migration-complete',
      r2Primary: isR2Primary(c.env),
      steps,
    });
  } catch (err) {
    return c.json({ error: err.message, steps }, 500);
  }
});

app.get('/kb/memory/:file', async (c) => {
  const file = c.req.param('file');
  const env = c.env;

  try {
    if (file === 'memory-index.md') {
      if (hasR2(env)) {
        const indexKey = buildGlobalMemoryIndexR2Key();
        const obj = await getFromR2(env, indexKey);
        if (obj?.content) {
          c.header('Content-Type', 'text/markdown; charset=utf-8');
          c.header('X-R2-Key', indexKey);
          return c.text(obj.content);
        }
      }

      const allMemories = await getAllChunkMemories(env);
      const memoryIndex = await buildMemoryIndexFromDB(env);
      c.header('Content-Type', 'text/markdown; charset=utf-8');
      return c.text(renderGlobalMemoryIndex(memoryIndex, allMemories));
    }

    let docId = file;
    let isJson = false;

    if (file.endsWith('.chunks.json')) {
      docId = file.replace('.chunks.json', '');
      isJson = true;
    } else if (file.endsWith('.memory.md')) {
      docId = file.replace('.memory.md', '');
    } else {
      return c.json({ error: 'Invalid file format. Use <docId>.memory.md or <docId>.chunks.json' }, 400);
    }

    if (hasR2(env)) {
      const { withClient } = await import('./services/db.js');
      const row = await withClient(env, async (client) => {
        const res = await client.query(
          `SELECT memory_r2_key, chunks_json_r2_key FROM kb_documents WHERE id = $1`,
          [docId]
        );
        return res.rows[0] || null;
      });

      const r2Key = isJson
        ? (row?.chunks_json_r2_key || `kb/memory/${docId}.chunks.json`)
        : (row?.memory_r2_key || `kb/memory/${docId}.memory.md`);

      const obj = await getFromR2(env, r2Key);
      if (obj?.content) {
        c.header('Content-Type', isJson ? 'application/json' : 'text/markdown; charset=utf-8');
        c.header('X-R2-Key', r2Key);
        return isJson ? c.json(JSON.parse(obj.content)) : c.text(obj.content);
      }
    }

    const memoryMap = await getChunkMemory(env, docId);
    const chunks = await getChunksByDocId(env, docId, 500, 0);

    if (!memoryMap && chunks.length === 0) {
      return c.json({ error: 'Memory map not found. Run POST /process/doc/:docId first.' }, 404);
    }

    if (isJson) return c.json(chunks);

    const { getDocById } = await import('./services/db.js');
    const doc = await getDocById(env, docId);
    const map = memoryMap || {
      docId,
      sourceUrl: doc?.url,
      title: doc?.title,
      timestamp: new Date().toISOString(),
      graphStats: {
        total: chunks.length,
        roots: chunks.filter(c => c.graph_role === 'root').length,
        branches: chunks.filter(c => c.graph_role === 'branch').length,
        leaves: chunks.filter(c => c.graph_role === 'leaf').length,
      },
    };

    const memoryIndex = await buildMemoryIndexFromDB(env);
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    return c.text(renderMemoryMd(map, chunks, memoryIndex));
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
