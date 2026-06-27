/**
 * crawler.js
 * Discovers all crawlable pages on a website.
 *
 * Strategy (in order):
 *   1. Fetch robots.txt → extract Sitemap: directives
 *   2. Try common sitemap paths (sitemap.xml, wp-sitemap.xml, etc.)
 *   3. Parse sitemap index → fetch sub-sitemaps
 *   4. Fallback: recursive href link crawl from homepage
 *
 * Also respects robots.txt Disallow rules.
 */

const USER_AGENT = 'KB-Formation-Bot/1.1 (Agentic RAG Knowledge Base Builder)';
const FETCH_TIMEOUT_MS = 10000;

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {string} baseUrl   - Starting URL (homepage or any page)
 * @param {number} maxPages  - Cap on number of pages to return
 * @param {object} env       - CF env (unused here, kept for consistency)
 * @returns {Array<{ url: string, title: string, source: string }>}
 */
export async function crawlSite(baseUrl, maxPages = 50, env) {
  const base = new URL(baseUrl);
  const origin = base.origin;

  console.log(`[crawler] crawlSite: ${origin}, max=${maxPages}`);

  // 1. Parse robots.txt for disallow rules + sitemap hints
  const { disallowed, sitemapUrls: robotsSitemaps } = await parseRobotsTxt(origin);
  console.log(`[crawler] robots.txt: ${disallowed.length} disallow rules, ${robotsSitemaps.length} sitemap hints`);

  // 2. Try sitemaps (robots hints first, then common paths)
  const sitemapCandidates = [
    ...robotsSitemaps,
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap/sitemap.xml`,
    `${origin}/wp-sitemap.xml`,
    `${origin}/news-sitemap.xml`,
    `${origin}/page-sitemap.xml`,
  ];

  let pages = [];
  for (const sitemapUrl of [...new Set(sitemapCandidates)]) {
    try {
      const found = await parseSitemap(sitemapUrl, origin);
      if (found.length > 0) {
        console.log(`[crawler] Sitemap ${sitemapUrl} → ${found.length} pages`);
        pages = found;
        break;
      }
    } catch {
      // Try next
    }
  }

  // 3. Fallback: link crawl
  if (pages.length === 0) {
    console.log(`[crawler] No sitemap found, falling back to recursive link crawl`);
    pages = await recursiveLinkCrawl(baseUrl, origin, maxPages, disallowed);
  }

  // 4. Apply robots disallow filtering + dedup + cap
  const filtered = pages
    .filter(p => !isDisallowed(p.url, origin, disallowed))
    .filter((p, i, arr) => arr.findIndex(x => x.url === p.url) === i) // dedup
    .slice(0, maxPages);

  console.log(`[crawler] Final: ${filtered.length} pages after filtering`);
  return filtered;
}

// ─── robots.txt ───────────────────────────────────────────────────────────────

async function parseRobotsTxt(origin) {
  const result = { disallowed: [], sitemapUrls: [] };

  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) return result;

    const text = await res.text();
    let inOurSection = false; // track if rules apply to us

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();

      // Track User-agent sections
      if (line.toLowerCase().startsWith('user-agent:')) {
        const agent = line.split(':')[1].trim();
        inOurSection = agent === '*' || agent.toLowerCase().includes('kb-formation');
        continue;
      }

      // Sitemap lines are global (not per-agent)
      if (line.toLowerCase().startsWith('sitemap:')) {
        const url = line.split(/sitemap:\s*/i)[1]?.trim();
        if (url) result.sitemapUrls.push(url);
        continue;
      }

      if (inOurSection && line.toLowerCase().startsWith('disallow:')) {
        const path = line.split(':')[1]?.trim();
        if (path && path !== '/') result.disallowed.push(path);
      }
    }
  } catch {
    // robots.txt is optional
  }

  return result;
}

function isDisallowed(url, origin, disallowed) {
  try {
    const pathname = new URL(url).pathname;
    return disallowed.some(rule => pathname.startsWith(rule));
  } catch {
    return false;
  }
}

// ─── Sitemap parsing ──────────────────────────────────────────────────────────

async function parseSitemap(sitemapUrl, origin) {
  const res = await fetch(sitemapUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });

  if (!res.ok) return [];

  const contentType = res.headers.get('content-type') || '';
  // Some servers return sitemap with wrong content-type, check XML anyway
  const xml = await res.text();

  if (!xml.includes('<') || xml.length < 50) return [];

  // Sitemap index (contains links to other sitemaps)
  if (xml.includes('<sitemapindex') || xml.includes('<sitemap>')) {
    return parseSitemapIndex(xml, origin);
  }

  // Regular URL set
  return parseUrlSet(xml, origin);
}

async function parseSitemapIndex(xml, origin) {
  // Extract <loc> tags that reference sub-sitemaps
  const sitemapLocs = extractLocs(xml)
    .filter(u => u.includes('sitemap') || u.endsWith('.xml'));

  const allPages = [];
  const limit = Math.min(sitemapLocs.length, 15); // cap at 15 sub-sitemaps

  for (const loc of sitemapLocs.slice(0, limit)) {
    try {
      const res = await fetch(loc, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!res.ok) continue;
      const xml2 = await res.text();
      allPages.push(...parseUrlSet(xml2, origin));
    } catch {
      // Skip failed sub-sitemaps
    }
  }

  return allPages;
}

function parseUrlSet(xml, origin) {
  return extractLocs(xml)
    .filter(u => isSameOrigin(u, origin))
    .filter(isContentUrl)
    .map(u => ({ url: normalizeUrl(u), title: '', source: 'sitemap' }));
}

function extractLocs(xml) {
  // Match both <loc> and CDATA-wrapped locs
  const matches = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*(https?:\/\/[^\s<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)];
  return matches.map(m => m[1].trim()).filter(Boolean);
}

// ─── Recursive link crawl ─────────────────────────────────────────────────────

async function recursiveLinkCrawl(startUrl, origin, maxPages, disallowed) {
  const visited = new Set();
  const queue = [normalizeUrl(startUrl)];
  const pages = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    if (isDisallowed(url, origin, disallowed)) continue;

    try {
      const { links, title } = await fetchPageLinks(url, origin);
      pages.push({ url, title, source: 'crawl' });

      for (const link of links) {
        if (!visited.has(link) && !queue.includes(link)) {
          queue.push(link);
        }
      }

      await sleep(300); // be polite
    } catch (err) {
      console.error(`[crawler] Failed link: ${url} — ${err.message}`);
    }
  }

  return pages;
}

async function fetchPageLinks(pageUrl, origin) {
  const res = await fetch(pageUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });

  if (!res.ok) return { links: [], title: '' };

  const html = await res.text();

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : '';

  const links = [...html.matchAll(/href=["']([^"'\s]+)["']/gi)]
    .map(m => m[1])
    .map(href => resolveUrl(href, pageUrl))
    .filter(u => u && isSameOrigin(u, origin) && isContentUrl(u))
    .map(normalizeUrl);

  return { links: [...new Set(links)], title };
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function isSameOrigin(url, origin) {
  try { return new URL(url).origin === origin; }
  catch { return false; }
}

/**
 * Returns false for URLs we should NOT crawl:
 * - binary assets (images, fonts, css, js, pdf, etc.)
 * - anchor-only links
 * - UTM/tracking params
 * - admin / API paths
 */
function isContentUrl(url) {
  const skip = [
    /\.(jpg|jpeg|png|gif|svg|webp|ico|pdf|zip|css|js|woff|woff2|ttf|eot|mp4|mp3|avi|mov|xml)(\?|$)/i,
    /#[^/]/,
    /[?&](utm_|ref=|session|token|nonce)/,
    /\/(wp-admin|wp-json|wp-login|wp-cron|wp-includes|api\/|feed\/|xmlrpc|cgi-bin|\.git)/i,
    /\/cdn-cgi\//,
    /\/(tag|category|author)\//i,
    /\/page\/\d+/,           // pagination
    /\/(cart|checkout|account|login|logout|register)\/?$/i,
  ];
  return !skip.some(r => r.test(url));
}

function resolveUrl(href, base) {
  try {
    if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) return null;
    return new URL(href, base).href.split('#')[0];
  } catch {
    return null;
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Remove tracking params
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'source'].forEach(p => {
      u.searchParams.delete(p);
    });
    // Remove trailing slash (except root)
    if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch {
    return url;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}