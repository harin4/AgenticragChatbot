/**
 * Cloudflare R2 operations for KB markdown blobs.
 * Neon stores metadata + r2_key pointer; R2 stores the actual markdown.
 */

export function hasR2(env) {
  return Boolean(env?.KB_BUCKET);
}

/** kb/<domain>/<slug>/<docId>.md */
export function buildRawDocR2Key(url, docId) {
  try {
    const u = new URL(url);
    const domain = u.hostname.replace(/\./g, '-');
    const path = u.pathname.replace(/^\//, '').replace(/\/$/, '') || 'index';
    const slug = path.replace(/[^a-z0-9-/]/gi, '-').replace(/\//g, '-');
    return `kb/${domain}/${slug}/${docId}.md`;
  } catch {
    return `kb/unknown/${docId}.md`;
  }
}

export function buildCleanedR2Key(docId) {
  return `kb/cleaned/${docId}.clean.md`;
}

export function buildMemoryR2Key(docId) {
  return `kb/memory/${docId}.memory.md`;
}

export function buildChunksJsonR2Key(docId) {
  return `kb/memory/${docId}.chunks.json`;
}

export function buildGlobalMemoryIndexR2Key() {
  return 'kb/memory/memory-index.md';
}

/** True when markdown blobs should live in R2 only (Neon stores pointers). */
export function isR2Primary(env) {
  return hasR2(env) && String(env?.R2_PRIMARY ?? 'true').toLowerCase() !== 'false';
}

export async function saveToR2(env, r2Key, content, metadata = {}) {
  if (!hasR2(env)) {
    console.warn('[r2] KB_BUCKET not bound — skipping save:', r2Key);
    return null;
  }

  await env.KB_BUCKET.put(r2Key, content, {
    httpMetadata: { contentType: metadata.contentType || 'text/markdown; charset=utf-8' },
    customMetadata: {
      url: metadata.url || '',
      title: metadata.title || '',
      docId: metadata.docId || '',
      jobId: metadata.jobId || '',
      type: metadata.type || 'markdown',
    },
  });

  console.log(`[r2] Saved: ${r2Key} (${content.length} chars)`);
  return r2Key;
}

export async function getFromR2(env, r2Key) {
  if (!hasR2(env) || !r2Key) return null;

  const obj = await env.KB_BUCKET.get(r2Key);
  if (!obj) return null;

  return {
    content: await obj.text(),
    metadata: obj.customMetadata || {},
    key: r2Key,
    size: obj.size,
  };
}

export async function listR2Documents(env, prefix = 'kb/') {
  if (!hasR2(env)) return [];

  const listed = await env.KB_BUCKET.list({ prefix, limit: 1000 });
  return (listed.objects || []).map(obj => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded,
    metadata: obj.customMetadata || {},
  }));
}

export async function deleteFromR2(env, r2Key) {
  if (!hasR2(env) || !r2Key) return null;
  await env.KB_BUCKET.delete(r2Key);
  console.log(`[r2] Deleted: ${r2Key}`);
  return r2Key;
}
