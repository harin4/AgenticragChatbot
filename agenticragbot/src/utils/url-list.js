/**
 * src/url-list.js
 * Manual URL list resolver — replaces sitemap crawling for sites where
 * Jina's sitemap parsing is unreliable or where you want explicit control
 * over which pages enter the KB.
 *
 * ─── WHY A JSON BODY (NOT A TEXT FILE OR SEPARATE API) ───────────────────────
 *
 * Three formats were considered:
 *
 *   1. Text file (.txt, one URL per line)
 *      ✗ Requires file hosting or Worker KV storage
 *      ✗ Versioning is manual
 *      ✗ Can't attach metadata (title hints, priority, tags) per URL
 *      ✓ Easy to edit in a text editor
 *
 *   2. Separate API endpoint (GET /urls → returns URL list)
 *      ✗ Another service to maintain and auth
 *      ✗ Adds a network hop before every crawl job
 *      ✓ Centralized source of truth if you already have a CMS
 *
 *   3. JSON in the POST /crawl request body  ← CHOSEN
 *      ✓ Zero extra infrastructure: the crawl request IS the URL list
 *      ✓ The admin panel already sends POST /crawl — extend the schema
 *      ✓ Per-URL metadata (title hint, priority) travels with the list
 *      ✓ Versioned naturally (save the request body as a JSON file locally)
 *      ✓ Works from curl, Postman, admin panel, or a scheduled script
 *      ✓ Consistent with the architecture: Worker ingests from HTTP, always
 *
 * REQUEST FORMAT (two modes):
 *
 *   Auto-crawl (original behaviour — sitemap/link fallback):
 *     POST /crawl
 *     { "url": "https://yoursite.com", "maxPages": 50 }
 *
 *   Manual URL list (new):
 *     POST /crawl
 *     {
 *       "urls": [
 *         "https://yoursite.com/about",
 *         "https://yoursite.com/pricing",
 *         { "url": "https://yoursite.com/docs/api", "title": "API Reference" }
 *       ],
 *       "skipExisting": true
 *     }
 *
 *   The `urls` array accepts either plain strings or objects with
 *   { url, title? } — title hints are used as a fallback if Jina can't
 *   extract a title from the page.
 *
 * ─── WHY THIS FORMAT FITS THE ARCHITECTURE ───────────────────────────────────
 *
 *   Looking at the ingestion layer (Image 1):
 *     Dynamic website → Admin panel → Jina r.jina.ai → AI chunker
 *
 *   The "Admin panel → Manual upload" arrow is exactly this: you paste a list
 *   of URLs into the admin panel, it POSTs them as the `urls` array, and the
 *   Worker hands each one to Jina. No crawler needed, no sitemap needed.
 *   The format is inspectable (JSON), editable, and reproducible.
 */

/**
 * Normalise the `urls` field from a POST /crawl body into a consistent
 * array of { url: string, title: string, source: 'manual' }.
 *
 * @param {Array<string|{url:string,title?:string}>} rawList
 * @param {number} maxPages
 * @returns {Array<{url:string, title:string, source:string}>}
 */
export function resolveManualUrls(rawList, maxPages = 200) {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new Error(
      'urls must be a non-empty array of strings or { url, title? } objects.\n' +
      'Example: { "urls": ["https://example.com/about", "https://example.com/pricing"] }'
    );
  }

  const pages = [];

  for (const item of rawList) {
    if (typeof item === 'string') {
      const normalised = normaliseUrl(item);
      if (normalised) pages.push({ url: normalised, title: '', source: 'manual' });
      continue;
    }

    if (item && typeof item === 'object' && typeof item.url === 'string') {
      const normalised = normaliseUrl(item.url);
      if (normalised) {
        pages.push({
          url:    normalised,
          title:  (item.title || '').trim(),
          source: 'manual',
        });
      }
      continue;
    }

    console.warn(`[url-list] Skipping invalid entry: ${JSON.stringify(item)}`);
  }

  if (pages.length === 0) {
    throw new Error('No valid URLs found in the urls array. Check that each entry is a valid https:// URL.');
  }

  // Deduplicate by normalised URL
  const seen = new Set();
  const deduped = pages.filter(p => {
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });

  const capped = deduped.slice(0, maxPages);

  if (deduped.length > maxPages) {
    console.warn(`[url-list] ${deduped.length} URLs provided, capped at ${maxPages}. Increase maxPages to process more.`);
  }

  console.log(`[url-list] Resolved ${capped.length} unique URLs from manual list`);
  return capped;
}

// ─── URL normalisation (same rules as crawler.js) ────────────────────────────

function normaliseUrl(raw) {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

    // Remove common tracking params
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'source'].forEach(p => {
      u.searchParams.delete(p);
    });

    // Strip trailing slash from non-root paths
    if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }

    return u.href;
  } catch {
    console.warn(`[url-list] Invalid URL skipped: "${trimmed}"`);
    return null;
  }
}