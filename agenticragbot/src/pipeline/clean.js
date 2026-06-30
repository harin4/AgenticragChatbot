/**
 * kb-pipeline/clean.js
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE A — CLEAN
 *
 * Input : raw Jina markdown (one page, with YAML front matter)
 * Output: a structured TOPIC TREE — not just stripped text.
 *
 *
 * Topic tree shape:
 *   {
 *     frontMatter: { title, source_url, scraped_at, ... },
 *     topics: [
 *       {
 *         level: 1,
 *         title: "What Is RAG",
 *         path: ["What Is RAG"],            ← full breadcrumb path
 *         paragraphs: ["Full, merged...",   ← sentence-complete paragraphs
 *                      "Another passage..."],
 *         images: [{ alt, shortUrl }],      ← only meaningful images
 *         children: [ ...same shape... ]
 *       }
 *     ],
 *     alerts: [                             ← every decision logged here
 *       { type: 'DROPPED_IMAGE', url, reason, line },
 *       { type: 'KEPT_IMAGE', url, alt, line },
 *       { type: 'STRIPPED_BOILERPLATE', text, line },
 *       { type: 'PROMOTED_HEADING', text, line },
 *       { type: 'DEDUPED_TOPIC', text },
 *     ],
 *     stats: { rawLines, cleanedParagraphs, topicCount, droppedImages, keptImages }
 *   }
 *
 * Pure function — no file I/O, no network calls.
 * server.js calls cleanMarkdown() and decides what to do with the result.
 */

// ─── Tunables ────────────────────────────────────────────────────────────────

const MIN_ALT_LEN  = 3;   // images with shorter alt text = decorative → drop
const MIN_PARA_LEN = 20;  // paragraphs below this length after merge = fragment → drop

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

/**
 * cleanMarkdown(rawMarkdown, docId)
 *
 * Main entry point. Returns a fully structured topic tree with alerts.
 *
 * @param {string} rawMarkdown  — raw Jina output (YAML front matter + body)
 * @param {string} docId        — slug used in alert messages / fallback topic names
 * @returns {{ frontMatter, topics, alerts, stats }}
 */
export function cleanMarkdown(rawMarkdown, docId = 'doc') {
  const { frontMatter, body } = parseFrontMatter(rawMarkdown);
  const alerts = [];

  // Step 1: Strip noise lines, triage images, remove boilerplate
  const { lines } = stripNoiseAndImages(body, docId, alerts);

  // Step 2: Re-flow — merge sentence fragments into complete paragraphs,
  //         promote **Bold Phrases** that act as headings into real ### headings
  const reflowed = reflowParagraphs(lines, alerts, docId);

  // Step 3: Build the heading tree (H1 → H2 → H3) from reflowed lines
  const topics = buildTopicTree(reflowed, alerts, docId);

  // Step 4: Deduplicate repeated topics (scraper artifacts — same section twice)
  dedupTopics(topics, alerts, docId);

  const stats = {
    rawLines:          body.split('\n').length,
    cleanedParagraphs: countParagraphs(topics),
    topicCount:        countTopics(topics),
    droppedImages:     alerts.filter(a => a.type === 'DROPPED_IMAGE').length,
    keptImages:        alerts.filter(a => a.type === 'KEPT_IMAGE').length,
  };

  return { frontMatter, topics, alerts, stats };
}

/**
 * renderTopicTree(frontMatter, topics)
 *
 * Renders the topic tree back to clean, human-readable markdown.
 * This is what gets saved in Neon as `clean_markdown` — the file a human
 * can read in the dashboard before it goes to the AI chunker.
 *
 * @param {object} frontMatter
 * @param {Array}  topics
 * @returns {string}
 */
export function renderTopicTree(frontMatter, topics) {
  const yamlLines = Object.entries(frontMatter || {}).map(([k, v]) => `${k}: "${v}"`);
  const body = [];

  function walk(topic) {
    const hashes = '#'.repeat(Math.min(topic.level, 3));
    body.push(`${hashes} ${topic.title}`, '');

    for (const p of topic.paragraphs) {
      body.push(p, '');
    }

    for (const img of topic.images) {
      body.push(`**[Image: ${img.alt}]** *(${img.shortUrl})*`, '');
    }

    for (const child of topic.children) {
      walk(child);
    }
  }

  for (const t of topics) walk(t);

  return ['---', ...yamlLines, 'cleaned: "true"', '---', '', ...body].join('\n').trim();
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 1 — Parse front matter
// ════════════════════════════════════════════════════════════════════════════

export function parseFrontMatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontMatter: {}, body: raw };

  const frontMatter = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([^:]+):\s*"?(.+?)"?\s*$/);
    if (m) frontMatter[m[1].trim()] = m[2].trim();
  }
  return { frontMatter, body: match[2] };
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 2 — Noise removal + image triage
// ════════════════════════════════════════════════════════════════════════════

function stripNoiseAndImages(body, docId, alerts) {
  const rawLines = body.split('\n');
  const out = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    // ── IMAGE TRIAGE ──────────────────────────────────────────────────────
    // Markdown image syntax: ![alt text](url)
    const imgMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      const alt = imgMatch[1].trim();
      const url = imgMatch[2].trim();

      if (!alt || alt.length < MIN_ALT_LEN) {
        // No meaningful description → ALERT + DROP
        // These are decorative spacers, icons, tracking pixels
        alerts.push({ type: 'DROPPED_IMAGE', url, reason: 'no/insufficient alt text', line: i + 1 });
        // Line is skipped entirely
        continue;
      }

      // Has real description → ALERT + KEEP
      // Convert to a sentinel the topic tree builder recognises and attaches
      // to the current topic node (instead of leaving it as inline noise).
      alerts.push({ type: 'KEPT_IMAGE', url, alt, line: i + 1 });
      out.push(`@@IMAGE@@${alt}@@${shortenUrl(url)}@@`);
      continue;
    }

    // ── BOILERPLATE ───────────────────────────────────────────────────────
    if (isBoilerplate(line)) {
      alerts.push({ type: 'STRIPPED_BOILERPLATE', text: line.trim().slice(0, 80), line: i + 1 });
      continue;
    }

    // ── JINA SOURCE CITATION LINES ────────────────────────────────────────
    // "> **Source:** ..." and "> **Scraped:** ..." — these live in front matter already
    if (/^>\s*\*\*(Source|Scraped):\*\*/.test(line)) continue;

    // ── INLINE LINK NOISE ─────────────────────────────────────────────────
    // Remove Jina's chunk:// internal links and excessively long URLs
    const cleanedLine = line
      .replace(/\[([^\]]+)\]\(chunk:\/\/[^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\(https?:\/\/[^)]{80,}\)/g, '$1');

    out.push(cleanedLine);
  }

  return { lines: out };
}

// ─── Boilerplate detector ─────────────────────────────────────────────────────

function isBoilerplate(line) {
  const raw = line.trim();
  const t = raw.toLowerCase();

  // ── NAV / LOGO LINKS ──────────────────────────────────────────────────────
  // e.g. "[The MERGEX Company](https://mergex.in/)[](https://mergex.in/)"
  // A line made up of nothing but one or more [text](url) tokens, with no
  // surrounding prose, is always a logo/nav/breadcrumb row — never content.
  if (/^(\[[^\]]*\]\([^)]+\)\s*)+$/.test(raw)) return true;

  // ── DECORATIVE SINGLE-CHAR / NUMBER FRAGMENTS ────────────────────────────
  // e.g. the "S  C  A  L  E" / "01  02  03" badge labels from a methodology
  // graphic, each scraped onto its own line. Real headings always carry a
  // markdown "#" and are excluded before this check runs in stripNoiseAndImages
  // order-wise — but to be safe we only match plain short alnum tokens here.
  if (!/^#{1,6}\s/.test(raw) && /^[A-Za-z0-9]{1,3}$/.test(raw)) return true;

  // ── DECORATIVE ALL-CAPS TAGLINES ─────────────────────────────────────────
  // e.g. "SCALING INFRASTRUCTURE COMPANY" sitting under a hero title. Real
  // markdown headings keep their "#" prefix and are never touched here.
  if (!/^#{1,6}\s/.test(raw) && raw.length <= 70 &&
      raw === raw.toUpperCase() && raw !== raw.toLowerCase() &&
      raw.trim().split(/\s+/).length > 1) {
    return true;
  }

  const NOISE_EXACT = [
    'back to top', 'scroll to top', '↑ back to top',
    'cookie policy', 'privacy policy', 'terms of service',
    'accept cookies', 'accept all cookies',
    'we use cookies', 'this site uses cookies',
    'all rights reserved',
    'share this page', 'share this article',
    'tags:', 'categories:',
    'related posts', 'related articles', 'you may also like',
    'subscribe to our newsletter', 'sign up for our newsletter',
    'follow us on', 'follow us:',
  ];

  const NOISE_STARTS = [
    'copyright ©', 'copyright (c)', '© 20', '©20',
    'all rights reserved',
    'last updated:', 'last modified:',
    'posted in:', 'filed under:',
    'reading time:', 'estimated reading',
    'share:', 'share on',
    '---',
  ];

  const NOISE_PATTERNS = [
    /^\[skip to (main )?content\]/,
    /^(home|about|contact|blog|services|portfolio)\s*[|›»>]\s*/i,
    /^menu\s*$/i,
    /^search\s*\.{0,3}\s*$/i,
    /^\d+ (min|minute) read$/i,
    /^[\d,]+ (views|shares|comments)$/i,
  ];

  if (NOISE_EXACT.includes(t)) return true;
  if (NOISE_STARTS.some(s => t.startsWith(s))) return true;
  if (NOISE_PATTERNS.some(p => p.test(t))) return true;
  return false;
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 30 ? u.pathname.slice(0, 30) + '…' : u.pathname;
    return u.hostname + path;
  } catch {
    return url.slice(0, 60);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 3 — Re-flow: turn noisy lines into real paragraphs
//
// Two jobs:
//   (a) Jina often hard-wraps mid-sentence. We merge consecutive non-heading
//       lines that don't end at sentence boundaries into single paragraphs.
//   (b) Promote **Bold Short Phrases** that act as visual sub-headings
//       (but aren't marked up as headings in the source HTML) into real ###
//       headings so the topic tree captures them properly.
// ════════════════════════════════════════════════════════════════════════════

function reflowParagraphs(lines, alerts, docId) {
  // Pass A: promote fake headings
  const nextNonBlank = (fromIndex) => {
    for (let j = fromIndex; j < lines.length; j++) {
      if (lines[j].trim() !== '') return lines[j];
    }
    return null;
  };

  const promoted = lines.map((line, i) => {
    if (looksLikeFakeHeading(line, nextNonBlank(i + 1))) {
      const title = line.replace(/^\*\*(.+)\*\*$/, '$1').trim();
      alerts.push({ type: 'PROMOTED_HEADING', text: title, line: i + 1 });
      return `### ${title}`;
    }
    return line;
  });

  // Pass B: merge soft-wrapped sentence fragments into complete paragraphs
  const merged = [];
  let buf = '';

  const flush = () => {
    const text = buf.trim();
    // Defense-in-depth: a bare 1-3 char fragment with no sentence punctuation
    // (badge letters/numbers that slipped past isBoilerplate) is noise, not
    // a paragraph. Real isBoilerplate filtering should catch these earlier;
    // this is a second safety net.
    if (text && !(text.length <= 3 && !/[.!?]$/.test(text))) {
      merged.push(text);
    } else if (text) {
      alerts.push({ type: 'STRIPPED_BOILERPLATE', text: `fragment: "${text}"` });
    }
    buf = '';
  };

  for (const line of promoted) {
    // Structural lines are never merged — they emit as-is
    const isStructural =
      /^#{1,6}\s/.test(line) ||   // headings
      /^[-*+]\s/.test(line) ||    // unordered list
      /^\d+\.\s/.test(line) ||    // ordered list
      /^@@IMAGE@@/.test(line) ||  // image sentinel
      /^>/.test(line) ||          // blockquote
      /^```/.test(line) ||        // code fence
      line.trim() === '';         // blank line

    if (isStructural) {
      flush();
      if (line.trim() !== '') merged.push(line);
      continue;
    }

    // Accumulate into buffer
    buf = buf ? `${buf} ${line.trim()}` : line.trim();

    // Sentence boundary: end punctuation + paragraph long enough to be real
    if (/[.!?:][)"'\u201d]?$/.test(buf) && buf.length > MIN_PARA_LEN) {
      flush();
    }
  }
  flush();

  return merged;
}

function looksLikeFakeHeading(line, nextLine) {
  const t = line.trim();
  if (!t || t.length > 70) return false;

  const boldOnly = t.match(/^\*\*([^*]{3,80})\*\*$/);

  // Plain (unmarked) short label, e.g. "Who We Are" — site styled it as a
  // heading visually, but Jina captured it as a bare line with no "#" or "**".
  const plainLabel = !boldOnly &&
    /^[A-Z][A-Za-z0-9&'’,.\-\s]{2,68}$/.test(t) &&
    !/[.!?:]$/.test(t)
    ? t
    : null;

  const candidate = boldOnly ? boldOnly[1] : plainLabel;
  if (!candidate) return false;
  if (/[.!?]$/.test(candidate)) return false; // ends like a sentence, not a heading

  // Decorative ALL-CAPS taglines (e.g. "SCALING INFRASTRUCTURE COMPANY") are
  // noise, not section headings — isBoilerplate() should already have
  // dropped these before reflow runs, but guard here too in case ordering
  // ever changes.
  if (candidate === candidate.toUpperCase() && candidate !== candidate.toLowerCase()) return false;

  // A real section label reads like a short title: 2–6 words.
  const wordCount = candidate.trim().split(/\s+/).length;
  if (wordCount < 2 || wordCount > 6) return false;

  // Only promote if followed by actual body content — otherwise it's just
  // another floating label (which isBoilerplate/the fragment guard handles).
  return !!(nextLine && nextLine.trim().length > MIN_PARA_LEN);
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 4 — Build topic tree from heading hierarchy
// ════════════════════════════════════════════════════════════════════════════

function buildTopicTree(lines, alerts, docId) {
  const root = [];
  const stack = []; // [{ level, node }]
  let current = null;

  function newNode(level, title) {
    return { level, title, path: [], paragraphs: [], images: [], children: [] };
  }

  function attach(node) {
    // Pop stack until we find a node at a lower level (= parent)
    while (stack.length && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    const parent = stack.length ? stack[stack.length - 1].node : null;
    node.path = parent ? [...parent.path, node.title] : [node.title];
    if (parent) parent.children.push(node);
    else root.push(node);
    stack.push({ level: node.level, node });
    current = node;
  }

  // If the document starts with body text before any heading, synthesize a root
  function ensureCurrent() {
    if (!current) {
      const fallback = newNode(1, humanizeDocId(docId));
      attach(fallback);
      alerts.push({ type: 'NO_H1_FOUND', text: `Synthesized root topic "${fallback.title}"` });
    }
  }

  for (const line of lines) {
    const h1  = line.match(/^#\s+(.+)$/);
    const h2  = line.match(/^##\s+(.+)$/);
    const h3  = line.match(/^###\s+(.+)$/);
    const img = line.match(/^@@IMAGE@@(.+?)@@(.+?)@@$/);

    if (h1) { attach(newNode(1, h1[1].trim())); continue; }
    if (h2) { ensureCurrent(); attach(newNode(2, h2[1].trim())); continue; }
    if (h3) { ensureCurrent(); attach(newNode(3, h3[1].trim())); continue; }

    if (img) {
      ensureCurrent();
      // Image attached to the current topic node — not floating as inline noise
      current.images.push({ alt: img[1], shortUrl: img[2] });
      continue;
    }

    // Plain paragraph / list item / blockquote → body of current topic
    ensureCurrent();
    if (line.trim()) current.paragraphs.push(line.trim());
  }

  return root;
}

function humanizeDocId(docId) {
  return docId.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 5 — Dedup repeated topic blocks
// Scrapers sometimes capture the same nav-adjacent section twice
// (e.g. a footer that mirrors a header, or a "Related" section appearing
// in both the sidebar and the bottom of the page).
// ════════════════════════════════════════════════════════════════════════════

function dedupTopics(topics, alerts, docId) {
  const seen = new Set();

  function walk(list) {
    for (let i = list.length - 1; i >= 0; i--) {
      const node = list[i];
      // Fingerprint: title + first 200 chars of content
      const fingerprint =
        node.title.toLowerCase().trim() + '::' +
        node.paragraphs.join(' ').slice(0, 200).toLowerCase();

      if (seen.has(fingerprint)) {
        alerts.push({ type: 'DEDUPED_TOPIC', text: node.title });
        list.splice(i, 1);
        continue;
      }
      seen.add(fingerprint);
      walk(node.children);
    }
  }

  walk(topics);
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

function countParagraphs(topics) {
  let n = 0;
  const walk = list => list.forEach(t => { n += t.paragraphs.length; walk(t.children); });
  walk(topics);
  return n;
}

function countTopics(topics) {
  let n = 0;
  const walk = list => list.forEach(t => { n += 1; walk(t.children); });
  walk(topics);
  return n;
}

/**
 * buildCleanedMarkdown
 * Alias for renderTopicTree (for compatibility with kb-pipeline/index.js)
 */
export function buildCleanedMarkdown(frontMatter, cleanedObj) {
  // cleanedObj has .lines from stripNoiseAndImages
  // For now, just reconstruct from existing renderTopicTree if we had topics
  // This is a pass-through that re-renders cleaned markdown
  return renderTopicTree(frontMatter, cleanedObj.topics || []);
}