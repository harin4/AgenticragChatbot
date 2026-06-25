// /**
//  * storage.js
//  * Handles all Cloudflare R2 operations.
//  * R2 is S3-compatible object storage — stores your markdown files.
//  *
//  * Folder structure in R2:
//  *   kb/<domain>/<slug>/<docId>.md   — the markdown content file (virtual folders via "/")
//  */

// // ─── Save a markdown file to R2 ──────────────────────────────────────────────

// export async function saveToR2(env, r2Key, content, metadata = {}) {
//   if (!env.KB_BUCKET) {
//     throw new Error('KB_BUCKET R2 binding not configured');
//   }

//   await env.KB_BUCKET.put(r2Key, content, {
//     httpMetadata: {
//       contentType: 'text/markdown; charset=utf-8',
//     },
//     customMetadata: {
//       url: metadata.url || '',
//       title: metadata.title || '',
//       docId: metadata.docId || '',
//       jobId: metadata.jobId || '',
//       crawledAt: metadata.crawledAt || new Date().toISOString(),
//     }
//   });

//   console.log(`[r2] Saved: ${r2Key} (${content.length} chars)`);
//   return r2Key;
// }

// // ─── Read a file from R2 ──────────────────────────────────────────────────────

// export async function getFromR2(env, r2Key) {
//   if (!env.KB_BUCKET) throw new Error('KB_BUCKET R2 binding not configured');

//   const obj = await env.KB_BUCKET.get(r2Key);
//   if (!obj) return null;

//   return {
//     content: await obj.text(),
//     metadata: obj.customMetadata || {},
//     httpMetadata: obj.httpMetadata || {},
//     key: r2Key,
//     size: obj.size,
//   };
// }

// // ─── List all KB documents in R2 ─────────────────────────────────────────────

// export async function listR2Documents(env, prefix = 'kb/') {
//   if (!env.KB_BUCKET) throw new Error('KB_BUCKET R2 binding not configured');

//   const listed = await env.KB_BUCKET.list({ prefix, limit: 1000 });

//   return listed.objects.map(obj => ({
//     key: obj.key,
//     size: obj.size,
//     uploaded: obj.uploaded,
//     metadata: obj.customMetadata || {},
//   }));
// }

// // ─── Delete a document from R2 ────────────────────────────────────────────────
// //
// // IMPORTANT: this takes the actual R2 key (e.g. "kb/example-com/about/<docId>.md"),
// // NOT the docId. The caller (index.js) already has the r2_key from Neon metadata,
// // so we delete directly instead of doing a full-bucket scan to find it.

// export async function deleteR2Document(env, r2Key) {
//   if (!env.KB_BUCKET) throw new Error('KB_BUCKET R2 binding not configured');
//   if (!r2Key) throw new Error('r2Key is required to delete a document');

//   await env.KB_BUCKET.delete(r2Key);
//   console.log(`[r2] Deleted: ${r2Key}`);
//   return r2Key;
// }
