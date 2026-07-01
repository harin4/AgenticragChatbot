/**
 * inspect-kb.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Inspection tool — run this to see:
 *   1. Raw markdown from kb_documents (what Jina scraped)
 *   2. What the cleaner WOULD produce (runs pipeline in-memory, no DB write)
 *   3. Chunks already stored in kb_chunks (what's in Neon right now)
 *   4. Quality report: what was dropped, what survived, alert breakdown
 *
 * USAGE:
 *   node inspect-kb.js                    → inspect all docs
 *   node inspect-kb.js --docId <id>       → inspect one doc
 *   node inspect-kb.js --raw              → show raw markdown only
 *   node inspect-kb.js --chunks           → show stored chunks only
 *   node inspect-kb.js --diff             → side-by-side raw vs cleaned
 *   node inspect-kb.js --export           → save everything to kb/inspect/
 *
 * OUTPUT:
 *   Prints to terminal with colour coding.
 *   With --export: writes files to kb/inspect/ folder you can open in VS Code.
 */

import fs from 'fs';
import path from 'path';

const API_URL = process.env.API_URL || 'http://127.0.0.1:8787';
const API_KEY = process.env.API_KEY || '';

const fetchOpts = API_KEY ? { headers: { 'Authorization': `Bearer ${API_KEY}` } } : {};

const args     = process.argv.slice(2);
const docIdArg = args.includes('--docId') ? args[args.indexOf('--docId') + 1] : null;
const RAW      = args.includes('--raw');
const CHUNKS   = args.includes('--chunks');
const DIFF     = args.includes('--diff');
const EXPORT   = args.includes('--export');

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const BLUE   = '\x1b[34m';
const GRAY   = '\x1b[90m';

function hr(char = '─', len = 70) { return char.repeat(len); }
function section(title) { console.log(`\n${BOLD}${CYAN}${hr('═')}${RESET}\n${BOLD}${CYAN} ${title}${RESET}\n${CYAN}${hr('═')}${RESET}`); }
function sub(title)     { console.log(`\n${BOLD}${BLUE}${hr('─')}${RESET}\n${BOLD} ${title}${RESET}\n${BLUE}${hr('─')}${RESET}`); }

// ─── Fetch docs ───────────────────────────────────────────────────────────────
async function getDocs() {
  if (docIdArg) {
    const res = await fetch(`${API_URL}/inspect/${docIdArg}`, fetchOpts);
    if (!res.ok) {
      console.error(`${RED}Error fetching doc ${docIdArg}: ${res.statusText}${RESET}`);
      process.exit(1);
    }
    const data = await res.json();
    if (data.error) {
      console.error(`${RED}${data.error}${RESET}`);
      process.exit(1);
    }
    // Attach the API payload so we don't have to recalculate or refetch later
    data.doc._apiPayload = data;
    return [data.doc];
  }
  
  const res = await fetch(`${API_URL}/inspect`, fetchOpts);
  if (!res.ok) {
    console.error(`${RED}Error fetching docs: ${res.statusText}${RESET}`);
    process.exit(1);
  }
  const data = await res.json();
  return data.docs;
}

async function getChunks(doc) {
  if (doc._apiPayload) return doc._apiPayload.storedChunks;
  const res = await fetch(`${API_URL}/inspect/${doc.id}`, fetchOpts);
  const data = await res.json();
  return data.storedChunks || [];
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const docs = await getDocs();

if (docs.length === 0) {
  console.log(`${RED}No documents found.${RESET}`);
  process.exit(0);
}

console.log(`\n${BOLD}KB Inspector${RESET} — ${docs.length} doc(s) found\n`);

if (EXPORT) fs.mkdirSync('kb/inspect', { recursive: true });

for (const doc of docs) {
  section(`DOC: ${doc.title || doc.id}`);
  console.log(`${GRAY}ID   : ${doc.id}${RESET}`);
  console.log(`${GRAY}URL  : ${doc.url}${RESET}`);
  console.log(`${GRAY}Words: ${doc.word_count}  Chars: ${doc.markdown_content?.length}${RESET}`);

  // ── 1. RAW MARKDOWN ────────────────────────────────────────────────────────
  if (!CHUNKS) {
    sub('1. RAW MARKDOWN (from Jina)');
    const raw = doc.markdown_content || '';
    const lines = raw.split('\n');
    console.log(`${GRAY}${lines.length} lines total${RESET}\n`);

    // Show first 60 lines with line numbers
    lines.slice(0, 60).forEach((line, i) => {
      const num   = String(i + 1).padStart(4, ' ');
      const isImg = /!\[/.test(line);
      const isBP  = /back to top|cookie|copyright|all rights/i.test(line);
      const isH   = /^#{1,3}\s/.test(line);
      const color = isImg ? YELLOW : isBP ? RED : isH ? GREEN : RESET;
      console.log(`${GRAY}${num}${RESET} ${color}${line}${RESET}`);
    });
    if (lines.length > 60) console.log(`${GRAY}  ... (${lines.length - 60} more lines — use --export to see full file)${RESET}`);

    if (EXPORT) {
      fs.writeFileSync(`kb/inspect/${doc.id}-1-raw.md`, raw);
      console.log(`${GREEN}  Exported → kb/inspect/${doc.id}-1-raw.md${RESET}`);
    }
  }

  // ── 2. CLEANED + CHUNKED (run pipeline live) ────────────────────────────────
  if (!RAW && !CHUNKS) {
    sub('2. PIPELINE OUTPUT (clean + chunk run live)');

    let cleaned, chunks, alerts;
    if (doc._apiPayload) {
      ({ cleaned, chunks, alerts } = doc._apiPayload.pipeline);
    } else {
      // If fetched from list view, fetch full details now
      const res = await fetch(`${API_URL}/inspect/${doc.id}`, fetchOpts);
      const data = await res.json();
      ({ cleaned, chunks, alerts } = data.pipeline);
    }

    // Alert breakdown
    console.log(`\n${BOLD}Alerts (${alerts.length} total):${RESET}`);
    const byType = {};
    for (const a of alerts) {
      byType[a.type] = (byType[a.type] || []);
      byType[a.type].push(a);
    }
    for (const [type, items] of Object.entries(byType)) {
      const icon = type.includes('DROPPED') ? `${RED}⚠ DROPPED${RESET}` :
                   type.includes('KEPT')    ? `${GREEN}✓ KEPT${RESET}` :
                   type.includes('STRIP')   ? `${YELLOW}⊘ STRIPPED${RESET}` :
                   type.includes('PROMO')   ? `${CYAN}↑ PROMOTED${RESET}` :
                   `${GRAY}· ${type}${RESET}`;
      console.log(`  ${icon} ×${items.length}`);
      items.slice(0, 3).forEach(a => console.log(`${GRAY}    → ${a.message}${RESET}`));
      if (items.length > 3) console.log(`${GRAY}    ... (${items.length - 3} more)${RESET}`);
    }

    // Cleaned markdown preview
    console.log(`\n${BOLD}Cleaned markdown (${cleaned.lines.length} lines):${RESET}`);
    cleaned.lines.slice(0, 50).forEach((line, i) => {
      const isH = /^#{1,3}\s/.test(line);
      const isImg = /\*\*\[Image:/.test(line);
      console.log(`${isH ? BOLD + GREEN : isImg ? YELLOW : RESET}${line}${RESET}`);
    });
    if (cleaned.lines.length > 50) console.log(`${GRAY}  ... (${cleaned.lines.length - 50} more lines)${RESET}`);

    // Chunk overview
    console.log(`\n${BOLD}Chunks produced (${chunks.length}):${RESET}`);
    for (const c of chunks) {
      const role  = c.graph_role === 'root'   ? `${GREEN}root  ${RESET}` :
                    c.graph_role === 'branch' ? `${CYAN}branch${RESET}` :
                                                `${GRAY}leaf  ${RESET}`;
      const img   = c.has_images ? ` ${YELLOW}[img]${RESET}` : '';
      const conns = [
        c.parent_id   ? `parent` : null,
        c.prev_id     ? `prev`   : null,
        c.next_id     ? `next`   : null,
        c.children_ids?.length ? `${c.children_ids.length} children` : null,
      ].filter(Boolean).join(', ');
      console.log(`  [${String(c.index).padStart(2)}] ${role} ${BOLD}${c.slug.slice(0,30).padEnd(30)}${RESET} ~${String(c.token_count).padStart(3)} tok  ${GRAY}${conns}${RESET}${img}`);
    }

    // Stats
    console.log(`\n${BOLD}Stats:${RESET}`);
    console.log(`  Raw lines    : ${doc.markdown_content.split('\n').length}`);
    console.log(`  Cleaned lines: ${cleaned.lines.length}`);
    console.log(`  Topics found : ${cleaned.stats.topicCount}`);
    console.log(`  Paragraphs   : ${cleaned.stats.cleanedParagraphs}`);
    console.log(`  Images kept  : ${GREEN}${cleaned.stats.keptImages}${RESET}`);
    console.log(`  Images dropped: ${RED}${cleaned.stats.droppedImages}${RESET}`);
    console.log(`  Total chunks : ${chunks.length}`);
    console.log(`  Avg tokens   : ${Math.round(chunks.reduce((s,c) => s+c.token_count,0)/chunks.length)}`);

    // Show full text of each chunk
    if (DIFF) {
      console.log(`\n${BOLD}Full chunk text:${RESET}`);
      for (const c of chunks) {
        console.log(`\n${CYAN}── Chunk [${c.index}] ${c.slug} (${c.token_count} tokens, ${c.graph_role}) ──${RESET}`);
        console.log(c.text);
      }
    }

    if (EXPORT) {
      fs.writeFileSync(`kb/inspect/${doc.id}-2-cleaned.md`, cleaned.markdown);
      fs.writeFileSync(`kb/inspect/${doc.id}-3-chunks.json`, JSON.stringify(chunks, null, 2));
      console.log(`\n${GREEN}  Exported → kb/inspect/${doc.id}-2-cleaned.md${RESET}`);
      console.log(`${GREEN}  Exported → kb/inspect/${doc.id}-3-chunks.json${RESET}`);
    }
  }

  // ── 3. STORED CHUNKS (what's actually in Neon) ──────────────────────────────
  if (!RAW) {
    sub('3. STORED CHUNKS IN NEON (kb_chunks table)');
    const stored = await getChunks(doc.id);

    if (stored.length === 0) {
      console.log(`${YELLOW}  No chunks stored yet for this doc. Run POST /process/doc/:id first.${RESET}`);
    } else {
      console.log(`${stored.length} chunks stored\n`);

      for (const c of stored) {
        const role  = c.graph_role === 'root'   ? `${GREEN}root  ${RESET}` :
                      c.graph_role === 'branch' ? `${CYAN}branch${RESET}` :
                                                  `${GRAY}leaf  ${RESET}`;
        const img   = c.has_images ? ` ${YELLOW}[img]${RESET}` : '';
        const path  = (c.heading_path || []).join(' › ');
        console.log(`  [${String(c.index).padStart(2)}] ${role} ${BOLD}${c.slug.slice(0,28).padEnd(28)}${RESET} ~${String(c.token_count).padStart(3)} tok  ${GRAY}${path}${RESET}${img}`);

        // Show first 3 lines of chunk text
        const preview = c.text.split('\n').slice(0,3).join(' ').slice(0,120);
        console.log(`${GRAY}       ${preview}…${RESET}`);
      }

      // Graph connectivity check
      console.log(`\n${BOLD}Graph connectivity:${RESET}`);
      const roots    = stored.filter(c => c.graph_role === 'root').length;
      const branches = stored.filter(c => c.graph_role === 'branch').length;
      const leaves   = stored.filter(c => c.graph_role === 'leaf').length;
      const orphans  = stored.filter(c => c.graph_role !== 'root' && !c.parent_id).length;
      const noNext   = stored.filter(c => !c.next_id).length;
      console.log(`  root: ${GREEN}${roots}${RESET}  branch: ${CYAN}${branches}${RESET}  leaf: ${GRAY}${leaves}${RESET}  orphans: ${orphans > 0 ? RED : GREEN}${orphans}${RESET}`);
      console.log(`  chunks with no next_id (end nodes): ${noNext}`);
    }
  }
}

console.log(`\n${BOLD}${GREEN}Done.${RESET}\n`);
if (EXPORT) console.log(`${GREEN}All files exported to kb/inspect/ — open in VS Code to read fully.${RESET}\n`);
