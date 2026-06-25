/**
 * jina.js
 * Scrapes any URL via Jina AI Reader API (r.jina.ai).
 *
 * BUGS FIXED:
 *   #9  — Hash-route URLs (#fragment) now use POST instead of GET
 *         (hash fragment is never sent to server in GET requests — wrong page returned silently)
 *   #10 — Silent 404 detection: checks both Jina's warning field AND content length
 *   #11 — Removed X-With-Links-Summary header (pollutes markdown with unrelated link noise)
 *
 * Features:
 *   - Returns clean markdown with YAML front matter
 *   - Retries on 429 with exponential backoff (respects Retry-After header)
 *   - Detects skeleton/empty content before returning
 *   - Handles hash-route SPAs via POST
 *   - Extracts title, word count, description from Jina response
 */

const JINA_BASE     = 'https://r.jina.ai';
const MAX_RETRIES   = 3;
const BASE_DELAY_MS = 2000;

// Words that indicate Jina captured a loading skeleton or bot-check page
const SKELETON_SIGNALS = [
  'loading...', 'please wait', 'javascript required',
  'enable javascript', 'checking your browser',
  'ddos protection', 'just a moment', 'cloudflare ray id',
  'access denied', 'verifying you are human',
];

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {string} pageUrl  - The page to scrape
 * @param {object} env      - Cloudflare Worker env (needs JINA_API_KEY)
 * @returns {{ markdown: string, title: string, wordCount: number, description: string, sourceUrl: string }}
 * @throws if content is empty, skeleton, or all retries fail
 */
export async function scrapeWithJina(pageUrl, env) {
  const headers = buildHeaders(env);

  // BUG FIXED #9: hash routes MUST use POST — GET strips the fragment before it hits the server
  const isHashRoute = pageUrl.includes('#');

  let attempt = 0;
  let lastError;

  while (attempt < MAX_RETRIES) {
    try {
      const res = await fetchFromJina(pageUrl, headers, isHashRoute);

      // Rate limited — respect Retry-After or exponential backoff
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '0');
        const waitMs = retryAfter > 0
          ? retryAfter * 1000
          : BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[jina] Rate limited on ${pageUrl}. Waiting ${waitMs}ms (attempt ${attempt + 1})...`);
        await sleep(waitMs);
        attempt++;
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Jina HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const raw = await res.json();

      // BUG FIXED #10: check Jina's warning field — 404 targets return HTTP 200 from Jina
      // but set data.warning = "..." and data.content = "Unknown."
      validateJinaResponse(pageUrl, raw);

      return buildOutput(pageUrl, raw);

    } catch (err) {
      lastError = err;
      attempt++;
      if (attempt < MAX_RETRIES) {
        const waitMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[jina] Retry ${attempt}/${MAX_RETRIES} for ${pageUrl}: ${err.message}`);
        await sleep(waitMs);
      }
    }
  }

  throw new Error(`Jina failed after ${MAX_RETRIES} attempts on ${pageUrl}: ${lastError?.message}`);
}

// ─── Request builder ──────────────────────────────────────────────────────────

function buildHeaders(env) {
  const headers = {
    'Accept': 'application/json',
    'X-Return-Format': 'markdown',
    'X-Timeout': '30',
    // Strip common nav/footer noise from markdown output
    'X-Remove-Selector': 'nav, footer, header, .cookie-banner, .popup, #cookie-consent, .nav-menu, .site-header',
    // BUG FIXED #11: removed X-With-Links-Summary — it appends a "Links" section
    // full of unrelated URLs that pollutes every markdown chunk sent to the AI chunker
  };

  if (env?.JINA_API_KEY) {
    headers['Authorization'] = `Bearer ${env.JINA_API_KEY}`;
  } else {
    // No key = 20 RPM hard cap. Fine for dev, not for production ingestion bursts.
    console.warn('[jina] No JINA_API_KEY — running on free tier (20 req/min limit)');
  }

  return headers;
}

async function fetchFromJina(pageUrl, headers, isHashRoute) {
  if (isHashRoute) {
    // BUG FIXED #9: POST body contains the full URL including hash fragment
    // Jina's Puppeteer picks it up and navigates to the correct SPA route
    return fetch(JINA_BASE + '/', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: pageUrl }),
      signal: AbortSignal.timeout(35000),
    });
  }

  return fetch(`${JINA_BASE}/${pageUrl}`, {
    headers,
    signal: AbortSignal.timeout(35000),
  });
}

// ─── Validation ───────────────────────────────────────────────────────────────

// BUG FIXED #10: surfaces both silent 404s and skeleton content
function validateJinaResponse(pageUrl, raw) {
  const d = raw?.data || raw;

  // Check 1: Jina's own warning field (set when target URL returns 4xx)
  if (d?.warning) {
    throw new Error(`Jina warning for ${pageUrl}: ${d.warning} — page may not exist or be accessible`);
  }

  const content = d?.content || d?.text || '';

  // Check 2: Content is suspiciously short (skeleton, empty body, or 404 page)
  if (content.length < 150) {
    throw new Error(
      `Jina returned only ${content.length} chars for ${pageUrl} — likely skeleton/empty page. Content: "${content.slice(0, 80)}"`
    );
  }

  // Check 3: Content contains loader/bot-check indicators
  const lower = content.toLowerCase();
  const skeletonMatch = SKELETON_SIGNALS.find(sig => lower.includes(sig));
  if (skeletonMatch) {
    throw new Error(
      `Jina captured skeleton/bot-check content ("${skeletonMatch}") for ${pageUrl} — JS not fully rendered`
    );
  }
}

// ─── Build structured output with YAML front matter ──────────────────────────

function buildOutput(pageUrl, jinaData) {
  const d = jinaData?.data || jinaData;

  const title     = cleanText(d.title || '') || urlToTitle(pageUrl);
  const content   = cleanContent(d.content || d.text || '');
  const sourceUrl = d.url || pageUrl;
  const desc      = extractDescription(content);
  const wordCount = countWords(content);
  const scrapedAt = new Date().toISOString();

  // Clean YAML front matter + document body
  // This format feeds directly into the AI chunker (Layer 1 → AI chunker arrow)
  const markdown = [
    '---',
    `title: "${escapeYaml(title)}"`,
    `source_url: "${sourceUrl}"`,
    `scraped_at: "${scrapedAt}"`,
    `word_count: ${wordCount}`,
    `description: "${escapeYaml(desc)}"`,
    '---',
    '',
    `# ${title}`,
    '',
    `> **Source:** ${sourceUrl}`,
    `> **Scraped:** ${formatDate(scrapedAt)}`,
    '',
    content,
  ].join('\n').trim();

  return { markdown, title, wordCount, description: desc, sourceUrl };
}

// ─── Content cleaning ─────────────────────────────────────────────────────────

function cleanContent(raw) {
  return raw
    // Remove cookie/consent boilerplate that leaks through
    .replace(/We use cookies.*?privacy policy\./gi, '')
    .replace(/Accept (all )?cookies?/gi, '')
    .replace(/This site uses cookies.*?\./gi, '')
    // Collapse 3+ blank lines → 2
    .replace(/\n{3,}/g, '\n\n')
    // Trim trailing whitespace per line
    .split('\n').map(l => l.trimEnd()).join('\n')
    .trim();
}

function cleanText(text) {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractDescription(content) {
  const lines = content.split('\n').map(l => l.trim());
  for (const line of lines) {
    if (
      line &&
      !line.startsWith('#') &&
      !line.startsWith('>') &&
      !line.startsWith('-') &&
      !line.startsWith('*') &&
      line.length > 30
    ) {
      return line.slice(0, 250).replace(/"/g, "'");
    }
  }
  return '';
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function escapeYaml(str) {
  return (str || '').replace(/"/g, "'").replace(/\n/g, ' ');
}

function urlToTitle(url) {
  try {
    const u   = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return u.hostname;
    return parts[parts.length - 1]
      .replace(/[-_]/g, ' ')
      .replace(/\.\w+$/, '')
      .replace(/\b\w/g, c => c.toUpperCase());
  } catch {
    return url;
  }
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}