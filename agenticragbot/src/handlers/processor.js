/**
 * Shared KB processing logic — used by Cloudflare Worker (and optionally Express).
 */
import { cleanAndChunkMarkdown } from '../pipeline/index.js';
import {
  saveChunks,
  saveChunkMemory,
  getAllChunkMemories,
  updateChunkRelatedIds,
  buildMemoryIndexFromDB,
  getChunkById,
} from '../chunk-db.js';
import { getDocById as getDocFromKB, updateDocR2Keys } from '../services/db.js';
import {
  hasR2,
  buildCleanedR2Key,
  buildMemoryR2Key,
  buildChunksJsonR2Key,
  buildGlobalMemoryIndexR2Key,
  saveToR2,
} from '../services/storage.js';
import { renderMemoryMd, renderGlobalMemoryIndex } from '../pipeline/memory.js';

export function buildMemoryMap(doc, chunks) {
  return {
    version: '1.2.0',
    docId: doc.id,
    sourceUrl: doc.url,
    title: doc.title,
    timestamp: new Date().toISOString(),
    chunks: chunks.map(c => ({
      id: c.id,
      index: c.index,
      slug: c.slug,
      headingPath: c.heading_path,
      tokenCount: c.token_count,
      graphRole: c.graph_role,
      hasImages: c.has_images,
      relatedIds: c.related_ids || [],
      connections: {
        prev: c.prev_id,
        next: c.next_id,
        parent: c.parent_id,
        children: c.children_ids,
      },
    })),
    graphStats: {
      total: chunks.length,
      roots: chunks.filter(c => c.graph_role === 'root').length,
      branches: chunks.filter(c => c.graph_role === 'branch').length,
      leaves: chunks.filter(c => c.graph_role === 'leaf').length,
    },
  };
}

export async function backfillRelatedIds(newChunks, newDocId, env) {
  const { normalizeTitle } = await import('../pipeline/chunk.js');

  const newDocIndex = {};
  for (const c of newChunks) {
    for (const title of (c.heading_path || [])) {
      const key = normalizeTitle(title);
      if (!newDocIndex[key]) newDocIndex[key] = [];
      newDocIndex[key].push(c.id);
    }
  }

  const allMemories = await getAllChunkMemories(env);
  let updated = 0;

  for (const memory of allMemories) {
    if (!memory?.chunks || memory.docId === newDocId) continue;

    for (const existingChunk of memory.chunks) {
      const headingPath = existingChunk.headingPath || existingChunk.heading_path || [];
      const newRelatedIds = [];
      for (const title of headingPath) {
        const key = normalizeTitle(title);
        const matches = (newDocIndex[key] || []).filter(id => !newRelatedIds.includes(id));
        newRelatedIds.push(...matches);
      }
      if (newRelatedIds.length === 0) continue;

      const currentChunk = await getChunkById(env, existingChunk.id).catch(() => null);
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

/** Process one kb_documents row through clean → chunk → save → backfill. */
export async function processDocument(env, docId) {
  const doc = await getDocFromKB(env, docId);
  if (!doc) return { error: 'not_found' };

  const memoryIndex = await buildMemoryIndexFromDB(env);
  const { cleaned, chunks, alerts } = await cleanAndChunkMarkdown(
    doc.markdown_content,
    docId,
    memoryIndex
  );

  await saveChunks(env, chunks);
  const memoryMap = buildMemoryMap(doc, chunks);
  await saveChunkMemory(env, docId, memoryMap);
  const backfillCount = await backfillRelatedIds(chunks, docId, env);
  const crossLinks = chunks.filter(c => (c.related_ids || []).length > 0).length;

  const r2Saved = {};
  if (hasR2(env)) {
    const cleanedKey = buildCleanedR2Key(docId);
    await saveToR2(env, cleanedKey, cleaned.markdown, {
      url: doc.url,
      title: doc.title || '',
      docId,
      type: 'cleaned',
    });
    r2Saved.cleaned = cleanedKey;

    const memoryMd = renderMemoryMd(memoryMap, chunks, memoryIndex);
    const memoryKey = buildMemoryR2Key(docId);
    await saveToR2(env, memoryKey, memoryMd, { docId, type: 'memory' });
    r2Saved.memory = memoryKey;

    const chunksKey = buildChunksJsonR2Key(docId);
    await saveToR2(env, chunksKey, JSON.stringify(chunks, null, 2), {
      docId,
      type: 'chunks-json',
      contentType: 'application/json',
    });
    r2Saved.chunksJson = chunksKey;

    await updateDocR2Keys(env, docId, {
      cleanedR2Key: cleanedKey,
      memoryR2Key: memoryKey,
      chunksJsonR2Key: chunksKey,
    });
  }

  return {
    doc,
    cleaned,
    chunks,
    alerts,
    memoryMap,
    backfillCount,
    crossLinks,
    r2Saved,
  };
}

export function memoryIndexResponse(memoryIndex) {
  const enriched = Object.entries(memoryIndex).map(([topic, refs]) => ({
    topic,
    docCount: [...new Set(refs.map(r => r.docId))].length,
    chunkCount: refs.length,
    refs,
  })).sort((a, b) => b.docCount - a.docCount);

  const sharedTopics = enriched.filter(e => e.docCount > 1);
  const docCount = new Set(enriched.flatMap(e => e.refs.map(r => r.docId))).size;

  return {
    totalTopics: enriched.length,
    sharedTopics: sharedTopics.length,
    docCount,
    crossDocEdges: sharedTopics.reduce((s, t) => s + t.chunkCount, 0),
    topics: enriched,
  };
}

/** Persist global memory-index.md to R2 (cross-doc topic graph). */
export async function saveGlobalMemoryIndexToR2(env) {
  if (!hasR2(env)) return null;

  const allMemories = await getAllChunkMemories(env);
  const memoryIndex = await buildMemoryIndexFromDB(env);
  const markdown = renderGlobalMemoryIndex(memoryIndex, allMemories);
  const key = buildGlobalMemoryIndexR2Key();

  await saveToR2(env, key, markdown, { type: 'memory-index' });
  return key;
}
