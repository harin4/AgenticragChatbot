/**
 * clean-and-chunk.js
 * ──────────────────────────────────────────────────────────────────────────────
 * PIPELINE: Raw Jina markdown → Cleaned Passages → Graph-Interconnected JSON Chunks
 *
 * USAGE:
 *   node scripts/clean-and-chunk.js <input.md> [output-dir]
 *   node scripts/clean-and-chunk.js kb/raw/about.md kb/chunks/
 *
 * WHAT IT DOES:
 *   Phase A — Clean
 *     1. Parse YAML front matter
 *     2. Strip image links with no description  (alert: logs which ones dropped)
 *     3. Keep image links that have ALT text    (alert: logs which ones kept)
 *     4. Remove boilerplate lines (nav leakage, cookie text, "Back to top", etc.)
 *     5. Collapse noisy whitespace and blank-line noise
 *     6. Rebuild human-readable topic→subtopic passage structure
 *
 *   Phase B — Chunk
 *     1. Parse heading tree (H1 → H2 → H3)
 *     2. Token-window each section (target: 200–400 tokens, hard max: 512)
 *     3. Merge tiny chunks < 80 tokens with their sibling
 *     4. Wire graph edges: prev/next (sibling), parent, children, external refs
 *     5. Emit chunks as JSON array (ready for Qdrant / pgvector embedding)
 *
 *   Alerts (printed to stderr, non-fatal):
 *     ⚠ DROPPED IMAGE — image link removed (no description)
 *     ✓ KEPT IMAGE    — image link preserved (has ALT text)
 *     ⚠ SHORT CHUNK   — merged into sibling
 *     ⚠ OVERSIZE      — chunk forcibly split
 *     ✓ CHUNK SUMMARY — final stats at end
 */

import fs from 'fs';
import path from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────
const TARGET_TOKENS   = 300;  // ideal chunk size
const MIN_TOKENS      = 80;   // merge if below this
const MAX_TOKENS      = 512;  // split if above this
// Rough estimate: 1 token ≈ 4 chars (English prose)
const charsPerToken   = 4;
const TARGET_CHARS    = TARGET_TOKENS * charsPerToken;
const MIN_CHARS       = MIN_TOKENS    * charsPerToken;
const MAX_CHARS       = MAX_TOKENS    * charsPerToken;

// ─── Entry point ──────────────────────────────────────────────────────────────
const [,, inputFile, outputDir = 'kb/chunks'] = process.argv;

if (!inputFile) {
  console.error('Usage: node scripts/clean-and-chunk.js <input.md> [output-dir]');
  process.exit(1);
}

const rawMarkdown = fs.readFileSync(inputFile, 'utf8');
const baseName    = path.basename(inputFile, '.md');

fs.mkdirSync(outputDir, { recursive: true });

// ─── Run ──────────────────────────────────────────────────────────────────────
const { frontMatter, body } = parseFrontMatter(rawMarkdown);
const cleaned               = cleanMarkdown(body, baseName);
const chunks                = chunkDocument(cleaned, frontMatter, baseName);
const graph                 = wireGraph(chunks);

// Write outputs
const cleanedPath = path.join(outputDir, `${baseName}.clean.md`);
const chunksPath  = path.join(outputDir, `${baseName}.chunks.json`);

fs.writeFileSync(cleanedPath, buildCleanedMarkdown(frontMatter, cleaned));
fs.writeFileSync(chunksPath,  JSON.stringify(graph, null, 2));

// Summary alert
console.error(`\n✓ CHUNK SUMMARY for ${baseName}`);
console.error(`  Input lines  : ${body.split('\n').length}`);
console.error(`  Cleaned lines: ${cleaned.lines.join('\n').split('\n').length}`);
console.error(`  Chunks       : ${graph.length}`);
console.error(`  → Cleaned MD : ${cleanedPath}`);
console.error(`  → Chunks JSON: ${chunksPath}`);
console.log(JSON.stringify(graph, null, 2)); // stdout = the chunks (pipe-able)


// ════════════════════════════════════════════════════════════════════════════
// PHASE A — CLEANING
// ════════════════════════════════════════════════════════════════════════════

/**
 * parseFrontMatter
 * Splits YAML front matter (--- block) from body.
 */
function parseFrontMatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontMatter: {}, body: raw };

  const yamlText = match[1];
  const body     = match[2];

  // Simple YAML key: value parser (no nested, covers our use case)
  const frontMatter = {};
  for (const line of yamlText.split('\n')) {
    const m = line.match(/^([^:]+):\s*"?(.+?)"?\s*$/);
    if (m) frontMatter[m[1].trim()] = m[2].trim();
  }

  return { frontMatter, body };
}

/**
 * cleanMarkdown
 * Core cleaning engine. Returns { lines, alerts }.
 */
function cleanMarkdown(body, docId) {
  const rawLines = body.split('\n');
  const cleaned  = [];
  const alerts   = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    // ── 1. IMAGES ──────────────────────────────────────────────────────────
    // Markdown image: ![alt text](url) or ![](url)
    const imgMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      const alt = imgMatch[1].trim();
      const url = imgMatch[2].trim();

      if (!alt || alt.length < 3) {
        // No meaningful description → DROP
        alerts.push({ type: 'DROPPED_IMAGE', url, reason: 'no alt text', line: i + 1 });
        console.error(`  ⚠ DROPPED IMAGE (line ${i + 1}): ${url.slice(0, 80)} — no description`);
        // Don't push this line
        continue;
      } else {
        // Has description → KEEP but rewrite as a structured passage reference
        alerts.push({ type: 'KEPT_IMAGE', url, alt, line: i + 1 });
        console.error(`  ✓ KEPT IMAGE (line ${i + 1}): "${alt}"`);
        // Replace raw image with a readable passage line
        cleaned.push(`**[Image: ${alt}]** *(visual reference — ${shortenUrl(url)})*`);
        continue;
      }
    }

    // ── 2. BOILERPLATE LINES ───────────────────────────────────────────────
    if (isBoilerplate(line)) {
      console.error(`  ⊘ STRIPPED BOILERPLATE (line ${i + 1}): "${line.trim().slice(0, 60)}"`);
      continue;
    }

    // ── 3. JINA SOURCE CITATION LINES ──────────────────────────────────────
    // The "> **Source:**" and "> **Scraped:**" lines from jina.js buildOutput
    if (/^>\s*\*\*(Source|Scraped):\*\*/.test(line)) {
      continue; // strip — this metadata lives in front matter already
    }

    // ── 4. INLINE LINK NOISE ───────────────────────────────────────────────
    // Remove Jina's internal chunk:// protocol links that leak into content
    const cleanedLine = line
      .replace(/\[([^\]]+)\]\(chunk:\/\/[^)]+\)/g, '$1') // chunk:// links → plain text
      .replace(/\[([^\]]+)\]\(https?:\/\/[^)]{80,}\)/g, '$1'); // Very long URLs → plain text

    // ── 5. BLANK LINE DEDUP ────────────────────────────────────────────────
    if (cleanedLine.trim() === '') {
      const lastAdded = cleaned[cleaned.length - 1];
      if (!lastAdded || lastAdded.trim() === '') continue; // dedup blanks
    }

    cleaned.push(cleanedLine);
  }

  return { lines: cleaned, alerts };
}

/**
 * isBoilerplate
 * Returns true for lines that are navigation/footer/cookie noise.
 */
function isBoilerplate(line) {
  const t = line.trim().toLowerCase();

  const NOISE_EXACT = [
    '', // covered by blank dedup, but defensive
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
    'copyright ©', 'copyright (c)',
    '© 20', '©20',
    'last updated:', 'last modified:',
    'posted in:', 'filed under:',
    'reading time:', 'estimated reading',
    'share:', 'share on',
    '---', // horizontal rule lines (not front matter)
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
    return u.hostname + (u.pathname.length > 30 ? u.pathname.slice(0, 30) + '…' : u.pathname);
  } catch {
    return url.slice(0, 60);
  }
}

function buildCleanedMarkdown(frontMatter, cleaned) {
  const yamlLines = Object.entries(frontMatter).map(([k, v]) => `${k}: "${v}"`);
  return [
    '---',
    ...yamlLines,
    'cleaned: true',
    '---',
    '',
    ...cleaned.lines,
  ].join('\n');
}


// ════════════════════════════════════════════════════════════════════════════
// PHASE B — CHUNKING
// ════════════════════════════════════════════════════════════════════════════

/**
 * chunkDocument
 * Turns cleaned lines into an array of raw chunk objects (before graph wiring).
 */
function chunkDocument(cleaned, frontMatter, docId) {
  const lines  = cleaned.lines;
  const chunks = [];

  let currentHeadings = { h1: '', h2: '', h3: '' }; // heading stack
  let buffer          = [];
  let bufferHeadings  = { ...currentHeadings };
  let chunkIndex      = 0;

  function flushBuffer() {
    if (buffer.length === 0) return;

    const text = buffer.join('\n').trim();
    if (!text) { buffer = []; return; }

    const tokenEstimate = Math.ceil(text.length / charsPerToken);

    // Oversized? Split into sub-chunks
    if (tokenEstimate > MAX_TOKENS) {
      const subChunks = splitOversized(text, bufferHeadings, docId, chunkIndex, frontMatter);
      console.error(`  ⚠ OVERSIZE: "${bufferHeadings.h2 || bufferHeadings.h1}" (${tokenEstimate} tokens) → split into ${subChunks.length} sub-chunks`);
      chunks.push(...subChunks);
      chunkIndex += subChunks.length;
    } else {
      chunks.push(buildChunk(text, { ...bufferHeadings }, docId, chunkIndex++, frontMatter));
    }

    buffer = [];
  }

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    const h3 = line.match(/^###\s+(.+)$/);

    if (h1) {
      flushBuffer();
      currentHeadings = { h1: h1[1].trim(), h2: '', h3: '' };
      bufferHeadings  = { ...currentHeadings };
      buffer.push(line); // include heading in chunk
    } else if (h2) {
      flushBuffer();
      currentHeadings = { ...currentHeadings, h2: h2[1].trim(), h3: '' };
      bufferHeadings  = { ...currentHeadings };
      buffer.push(line);
    } else if (h3) {
      flushBuffer();
      currentHeadings = { ...currentHeadings, h3: h3[1].trim() };
      bufferHeadings  = { ...currentHeadings };
      buffer.push(line);
    } else {
      buffer.push(line);

      // Soft flush at target size
      const currentSize = buffer.join('\n').length;
      if (currentSize >= TARGET_CHARS) {
        // Only flush at a paragraph boundary (blank line)
        if (line.trim() === '') {
          flushBuffer();
          bufferHeadings = { ...currentHeadings }; // inherit headings for next chunk
        }
      }
    }
  }

  flushBuffer(); // flush remainder

  // Merge tiny chunks into their previous sibling
  return mergeTinyChunks(chunks);
}

/**
 * buildChunk
 * Constructs a single chunk object.
 */
function buildChunk(text, headings, docId, index, frontMatter) {
  const slug        = makeSlug(headings);
  const id          = `${docId}#${slug}-${index}`;
  const tokenCount  = Math.ceil(text.length / charsPerToken);
  const headingPath = [headings.h1, headings.h2, headings.h3].filter(Boolean);

  return {
    id,
    doc_id:       docId,
    index,
    source_url:   frontMatter.source_url || '',
    heading_path: headingPath,
    slug,
    text:         text.trim(),
    token_count:  tokenCount,
    // Graph fields — wired in wireGraph()
    prev_id:      null,
    next_id:      null,
    parent_id:    null,
    children_ids: [],
    // Image references if any
    has_images:   /\*\*\[Image:/.test(text),
  };
}

/**
 * splitOversized
 * Splits a large text block into paragraph-boundary sub-chunks.
 */
function splitOversized(text, headings, docId, startIndex, frontMatter) {
  const paragraphs = text.split(/\n\n+/);
  const subChunks  = [];
  let buffer       = [];
  let subIndex     = 0;

  for (const para of paragraphs) {
    buffer.push(para);
    const size = buffer.join('\n\n').length;

    if (size >= TARGET_CHARS) {
      subChunks.push(buildChunk(
        buffer.join('\n\n'),
        headings,
        docId,
        startIndex + subIndex,
        frontMatter
      ));
      subIndex++;
      buffer = [];
    }
  }

  if (buffer.length > 0) {
    subChunks.push(buildChunk(
      buffer.join('\n\n'),
      headings,
      docId,
      startIndex + subIndex,
      frontMatter
    ));
  }

  return subChunks;
}

/**
 * mergeTinyChunks
 * Any chunk < MIN_TOKENS gets merged into the previous chunk.
 */
function mergeTinyChunks(chunks) {
  const result = [];

  for (const chunk of chunks) {
    if (chunk.token_count < MIN_TOKENS && result.length > 0) {
      const prev = result[result.length - 1];
      console.error(`  ⚠ SHORT CHUNK: "${chunk.id}" (${chunk.token_count} tokens) → merging into "${prev.id}"`);
      prev.text        += '\n\n' + chunk.text;
      prev.token_count  = Math.ceil(prev.text.length / charsPerToken);
      prev.children_ids.push(chunk.id); // soft child reference
    } else {
      result.push(chunk);
    }
  }

  return result;
}

/**
 * wireGraph
 * Adds prev/next sibling links and parent/child relationships.
 * This creates graph-traversable interconnected chunks for the RAG agent.
 */
function wireGraph(chunks) {
  // Pass 1: prev/next sibling wiring (linear order)
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0)               chunks[i].prev_id  = chunks[i - 1].id;
    if (i < chunks.length-1) chunks[i].next_id  = chunks[i + 1].id;
  }

  // Pass 2: parent/child wiring based on heading depth
  // Strategy: a chunk is a "child" of the nearest preceding chunk at a higher heading level
  for (let i = 0; i < chunks.length; i++) {
    const cur  = chunks[i];
    const curDepth = headingDepth(cur.heading_path);

    // Walk backwards to find parent (lower depth = higher in tree)
    for (let j = i - 1; j >= 0; j--) {
      const candidate = chunks[j];
      const candDepth = headingDepth(candidate.heading_path);

      if (candDepth < curDepth) {
        cur.parent_id = candidate.id;
        if (!candidate.children_ids.includes(cur.id)) {
          candidate.children_ids.push(cur.id);
        }
        break;
      }
    }
  }

  // Pass 3: tag each chunk with its graph role for the RAG agent
  for (const chunk of chunks) {
    chunk.graph_role = chunk.parent_id === null ? 'root' :
                       chunk.children_ids.length > 0 ? 'branch' : 'leaf';
  }

  return chunks;
}

/**
 * headingDepth
 * Returns 1/2/3 based on how deep the heading path goes.
 */
function headingDepth(headingPath) {
  return headingPath.length; // [h1] = 1, [h1, h2] = 2, [h1, h2, h3] = 3
}

/**
 * makeSlug
 * Builds a URL-safe slug from the current heading context.
 */
function makeSlug(headings) {
  const parts = [headings.h1, headings.h2, headings.h3]
    .filter(Boolean)
    .map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  return parts[parts.length - 1] || 'section';
}