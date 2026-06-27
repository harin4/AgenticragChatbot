/**
 * server.js — KB Processor Layer 1.5  (UPDATED)
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED FROM YOUR CURRENT VERSION:
 *
 *   1. Memory index loaded from Neon BEFORE chunking each doc
 *      → chunk.js now receives real cross-doc data → related_ids populated ✅
 *
 *   2. After saving chunks, writes physical memory.md files to kb/memory/
 *      → one per-doc .memory.md + one global memory-index.md ✅
 *
 *   3. Back-fill pass after each doc: updates previously-saved chunks
 *      whose related_ids now point to the just-processed doc ✅
 *
 *   4. New route GET /memory-index → full cross-doc topic graph ✅
 *
 *   5. PORT conflict guard — exits cleanly with a helpful message instead
 *      of the raw EADDRINUSE stack trace you got ✅
 *
 * ALL EXISTING ROUTES UNCHANGED.
 */

import express from 'express';
import cors    from 'cors';
import dotenv  from 'dotenv';
import fs      from 'fs';
import path    from 'path';

import { cleanAndChunkMarkdown }        from './kb-pipeline/index.js';
import {
  buildMemoryIndex,
  saveMemoryMdFiles,
  saveGlobalMemoryIndex,
}                                        from './kb-pipeline/memory.js';
import {
  initChunkSchema,
  saveChunks,
  getChunksByDocId,
  getChunkById,
  deleteChunkCascade,
  saveChunkMemory,
  getChunkMemory,
  listDocsNeedingChunking,
  getAllChunkMemories,
  updateChunkRelatedIds,
}                                        from './src/chunk-db.js';
import { getDocById as getDocFromKB }   from './src/db.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3001');
const env  = { DATABASE_URL: process.env.DATABASE_URL };

// ─── Express setup ────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve kb/memory/ directory so files are browsable via browser
app.use('/kb/memory', express.static('./kb/memory'));

// ════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /process/doc/:docId
 *
 * Full pipeline:
 *   1. Fetch raw doc from Neon kb_documents
 *   2. Load cross-doc memory index from kb_chunk_memory (ALL prior docs)
 *   3. Clean + chunk (chunk.js now receives real memoryIndex → related_ids populated)
 *   4. Save chunks to Neon kb_chunks
 *   5. Save memory map to kb_chunk_memory
 *   6. Write .memory.md + .chunks.json files to kb/memory/
 *   7. Back-fill related_ids in previously-saved chunks that share topics
 *   8. Regenerate global memory-index.md
 */
app.post('/process/doc/:docId', async (req, res) => {
  const { docId } = req.params;

  try {
    // Step 1: Fetch raw doc
    const doc = await getDocFromKB(env, docId);
    if (!doc) return res.status(404).json({ error: 'Document not found in KB' });

    console.log(`\n[process] ── Starting: docId=${docId}  (${doc.markdown_content.length} chars)`);

    // Step 2: Load memory index from ALL prior processed docs
    // FIX: This is what was missing — without loading prior docs' topics,
    // the chunker had no data to wire related_ids from.
    const allPriorMemories = await getAllChunkMemories(env);
    const memoryIndex = buildMemoryIndex(allPriorMemories);
    console.log(`[process] Memory index loaded: ${Object.keys(memoryIndex).length} topics from ${allPriorMemories.length} prior docs`);

    // Step 3: Clean + chunk (memoryIndex passed in → related_ids populated)
    const { cleaned, chunks, alerts } = await cleanAndChunkMarkdown(
      doc.markdown_content,
      docId,
      memoryIndex
    );
    console.log(`[process] Generated ${chunks.length} chunks, ${alerts.length} alerts`);

    // Step 4: Save chunks to Neon
    await saveChunks(env, chunks);

    // Step 5: Build + save memory map to Neon
    const memoryMap = buildMemoryMap(doc, chunks);
    await saveChunkMemory(env, docId, memoryMap);

    // Step 6: Write physical memory.md + chunks.json files
    // FIX: This is the "memory.md files" your mentor described — now actually written
    saveMemoryMdFiles(docId, memoryMap, chunks, memoryIndex);

    // Step 7: Back-fill related_ids in PRIOR chunks that share topics with this doc
    // Without this, doc A would never know about doc B's matching chunks even after
    // doc B is processed. This pass fixes that.
    const backfillCount = await backfillRelatedIds(chunks, docId, env);
    if (backfillCount > 0) {
      console.log(`[process] Back-filled related_ids in ${backfillCount} prior chunks`);
    }

    // Step 8: Regenerate global memory-index.md with all docs including this one
    const allMemories = await getAllChunkMemories(env);
    const updatedIndex = buildMemoryIndex(allMemories);
    saveGlobalMemoryIndex(updatedIndex, allMemories);

    // Response
    const crossLinks = chunks.filter(c => (c.related_ids || []).length > 0).length;
    res.json({
      status:       'processed',
      docId,
      url:          doc.url,
      title:        doc.title,
      chunkCount:   chunks.length,
      avgTokens:    Math.round(chunks.reduce((s, c) => s + c.token_count, 0) / chunks.length),
      crossLinks,   // NEW: how many chunks have cross-doc related_ids
      alerts,
      savedChunks:  chunks.length,
      backfilled:   backfillCount,
      memoryFiles: {
        perDoc:       `kb/memory/${docId}.memory.md`,
        chunksJson:   `kb/memory/${docId}.chunks.json`,
        globalIndex:  'kb/memory/memory-index.md',
      },
      memory: {
        docId,
        version:   memoryMap.version,
        timestamp: memoryMap.timestamp,
        chunks:    memoryMap.chunks.length,
        graphStats: memoryMap.graphStats,
      },
    });

  } catch (err) {
    console.error(`[process] Error on docId=${docId}:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /process/batch
 * Process multiple docs — correctly ordered so each doc sees all prior docs.
 * FIX: processes serially (not parallel) so the memory index grows incrementally.
 * Processing in parallel would mean all docs see the same stale empty index.
 */
app.post('/process/batch', async (req, res) => {
  const { docIds } = req.body;

  if (!Array.isArray(docIds) || docIds.length === 0) {
    return res.status(400).json({ error: 'docIds must be a non-empty array' });
  }

  const results = [];
  const errors  = [];

  // Serial processing — each doc builds on the memory of the previous
  for (const docId of docIds) {
    try {
      const doc = await getDocFromKB(env, docId);
      if (!doc) { errors.push({ docId, error: 'not found' }); continue; }

      const allPriorMemories = await getAllChunkMemories(env);
      const memoryIndex = buildMemoryIndex(allPriorMemories);

      const { chunks, alerts } = await cleanAndChunkMarkdown(
        doc.markdown_content,
        docId,
        memoryIndex
      );

      await saveChunks(env, chunks);
      const memoryMap = buildMemoryMap(doc, chunks);
      await saveChunkMemory(env, docId, memoryMap);
      saveMemoryMdFiles(docId, memoryMap, chunks, memoryIndex);
      const backfillCount = await backfillRelatedIds(chunks, docId, env);

      const crossLinks = chunks.filter(c => (c.related_ids || []).length > 0).length;
      results.push({ docId, chunkCount: chunks.length, crossLinks, backfilled: backfillCount, status: 'ok' });
      console.log(`[batch] ✓ ${docId} → ${chunks.length} chunks, ${crossLinks} cross-links`);

    } catch (err) {
      errors.push({ docId, error: err.message });
      console.error(`[batch] ✗ ${docId}:`, err.message);
    }
  }

  // Final global index after all docs processed
  const allMemories = await getAllChunkMemories(env);
  saveGlobalMemoryIndex(buildMemoryIndex(allMemories), allMemories);

  res.json({
    status:    'batch-completed',
    processed: results.length,
    failed:    errors.length,
    results,
    errors:    errors.length > 0 ? errors : undefined,
  });
});

/**
 * POST /process/raw
 * For testing: send raw markdown, get cleaned + chunks (no DB save).
 */
app.post('/process/raw', async (req, res) => {
  const { markdown, docId = 'test-doc' } = req.body;
  if (!markdown || typeof markdown !== 'string') {
    return res.status(400).json({ error: 'markdown field required (string)' });
  }

  try {
    const { cleaned, chunks, alerts } = await cleanAndChunkMarkdown(markdown, docId);
    res.json({
      status:  'processed-raw',
      docId,
      cleaned: { lines: cleaned.lines.length, text: cleaned.markdown, stats: cleaned.stats },
      chunks,
      alerts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /memory/:docId
 * Returns the JSON memory map from Neon for a doc.
 */
app.get('/memory/:docId', async (req, res) => {
  try {
    const memory = await getChunkMemory(env, req.params.docId);
    if (!memory) return res.status(404).json({ error: 'Memory map not found. Process doc first.' });
    res.json(memory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /memory-index
 * Returns the full cross-doc topic graph (the global memory index).
 * NEW route — exposes what memory-index.md contains as JSON.
 */
app.get('/memory-index', async (req, res) => {
  try {
    const allMemories = await getAllChunkMemories(env);
    const memoryIndex = buildMemoryIndex(allMemories);

    // Enrich with topic count and doc count per entry
    const enriched = Object.entries(memoryIndex).map(([topic, refs]) => ({
      topic,
      docCount: [...new Set(refs.map(r => r.docId))].length,
      chunkCount: refs.length,
      refs,
    })).sort((a, b) => b.docCount - a.docCount);

    const sharedTopics = enriched.filter(e => e.docCount > 1);

    res.json({
      totalTopics:    enriched.length,
      sharedTopics:   sharedTopics.length,
      docCount:       allMemories.length,
      crossDocEdges:  sharedTopics.reduce((s, t) => s + t.chunkCount, 0),
      topics:         enriched,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /chunks/:chunkId
 */
app.get('/chunks/:chunkId', async (req, res) => {
  try {
    const chunk = await getChunkById(env, req.params.chunkId);
    if (!chunk) return res.status(404).json({ error: 'Chunk not found' });
    res.json(chunk);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /chunks?docId=...&limit=50&offset=0
 */
app.get('/chunks', async (req, res) => {
  const { docId, limit = '50', offset = '0' } = req.query;
  if (!docId) return res.status(400).json({ error: 'docId query param required' });
  try {
    const chunks = await getChunksByDocId(env, docId, parseInt(limit), parseInt(offset));
    res.json({ docId, count: chunks.length, data: chunks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /chunks/:chunkId
 */
app.delete('/chunks/:chunkId', async (req, res) => {
  try {
    const docId = await deleteChunkCascade(env, req.params.chunkId);
    res.json({ status: 'deleted', chunkId: req.params.chunkId, docId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /init
 */
app.post('/init', async (req, res) => {
  try {
    await initChunkSchema(env);
    res.json({ status: 'initialized', tables: ['kb_chunks', 'kb_chunk_memory'] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    service:  'KB Processor — Layer 1.5',
    version:  '1.1.0',
    layer:    'Clean + Chunk + Graph + Memory',
    memoryFiles: 'kb/memory/*.memory.md  |  kb/memory/memory-index.md',
    endpoints: {
      process_single: 'POST /process/doc/:docId',
      process_batch:  'POST /process/batch',
      process_raw:    'POST /process/raw (testing)',
      memory_json:    'GET /memory/:docId',
      memory_index:   'GET /memory-index',
      memory_files:   'GET /kb/memory/<docId>.memory.md (static)',
      chunk:          'GET /chunks/:chunkId',
      chunks_list:    'GET /chunks?docId=...',
      delete_chunk:   'DELETE /chunks/:chunkId',
      init:           'POST /init',
    },
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function buildMemoryMap(doc, chunks) {
  return {
    version:    '1.1.0',
    docId:      doc.id,
    sourceUrl:  doc.url,
    title:      doc.title,
    timestamp:  new Date().toISOString(),
    chunks: chunks.map(c => ({
      id:           c.id,
      index:        c.index,
      slug:         c.slug,
      headingPath:  c.heading_path,
      tokenCount:   c.token_count,
      graphRole:    c.graph_role,
      hasImages:    c.has_images,
      relatedIds:   c.related_ids || [],
      connections: {
        prev:     c.prev_id,
        next:     c.next_id,
        parent:   c.parent_id,
        children: c.children_ids,
      },
    })),
    graphStats: {
      total:    chunks.length,
      roots:    chunks.filter(c => c.graph_role === 'root').length,
      branches: chunks.filter(c => c.graph_role === 'branch').length,
      leaves:   chunks.filter(c => c.graph_role === 'leaf').length,
    },
  };
}

/**
 * backfillRelatedIds
 *
 * After processing a NEW doc, older docs whose chunks share the same topic
 * titles need their related_ids updated to include chunks from the new doc.
 *
 * Without this, Doc A (processed first) would never know about Doc B's
 * chunks even after Doc B is processed. This pass fixes that retroactively.
 *
 * @param {Array}  newChunks  — chunks just produced from the new doc
 * @param {string} newDocId
 * @param {object} env
 * @returns {number} count of chunks updated
 */
async function backfillRelatedIds(newChunks, newDocId, env) {
  const { normalizeTitle } = await import('./kb-pipeline/chunk.js');

  // Build lookup: normalizedTitle → chunkId for the new doc's chunks
  const newDocIndex = {};
  for (const c of newChunks) {
    for (const title of (c.heading_path || [])) {
      const key = normalizeTitle(title);
      if (!newDocIndex[key]) newDocIndex[key] = [];
      newDocIndex[key].push(c.id);
    }
  }

  // Load all OTHER docs' memory maps, find chunks that share topic titles
  const allMemories = await getAllChunkMemories(env);
  let updated = 0;

  for (const memory of allMemories) {
    if (!memory?.chunks || memory.docId === newDocId) continue;

    for (const existingChunk of memory.chunks) {
      const headingPath = existingChunk.headingPath || existingChunk.heading_path || [];

      // Find new doc's chunks that match any heading in this existing chunk's path
      const newRelatedIds = [];
      for (const title of headingPath) {
        const key = normalizeTitle(title);
        const matches = (newDocIndex[key] || []).filter(id => !newRelatedIds.includes(id));
        newRelatedIds.push(...matches);
      }

      if (newRelatedIds.length === 0) continue;

      // Update this existing chunk's related_ids in Neon to include new doc's chunks
      const currentChunk = await import('./src/chunk-db.js')
        .then(m => m.getChunkById(env, existingChunk.id))
        .catch(() => null);

      if (!currentChunk) continue;

      const currentRelated = currentChunk.related_ids || [];
      const merged = [...new Set([...currentRelated, ...newRelatedIds])].slice(0, 10);

      if (merged.length > currentRelated.length) {
        await updateChunkRelatedIds(env, existingChunk.id, merged);
        updated++;
      }
    }
  }

  return updated;
}

// ════════════════════════════════════════════════════════════════════════════
// START SERVER — with PORT conflict guard
// ════════════════════════════════════════════════════════════════════════════

const server = app.listen(PORT, () => {
  console.log(`\n✓ KB Processor (Layer 1.5) v1.1.0 running on port ${PORT}`);
  console.log(`  POST   /process/doc/:docId   ← main pipeline`);
  console.log(`  POST   /process/batch        ← batch mode`);
  console.log(`  GET    /memory-index         ← cross-doc graph`);
  console.log(`  GET    /memory/:docId        ← per-doc memory`);
  console.log(`  GET    /kb/memory/<file>.md  ← static memory files`);
  console.log(`  GET    /health\n`);
});

// FIX: clean error on port conflict instead of raw stack trace
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗ Port ${PORT} is already in use.`);
    console.error(`  Kill the existing process first:`);
    console.error(`    Windows:  netstat -ano | findstr :${PORT}  then  taskkill /PID <pid> /F`);
    console.error(`    Mac/Linux: lsof -ti :${PORT} | xargs kill -9`);
    console.error(`  Or set a different port:  PORT=3002 node server.js\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

export default app;
