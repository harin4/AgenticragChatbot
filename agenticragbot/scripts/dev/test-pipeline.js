/**
 * scripts/test-pipeline.js
 * Quick smoke test — runs the clean+chunk pipeline on a sample markdown string.
 * No DB needed. Run with: node scripts/test-pipeline.js
 */
import { cleanAndChunkMarkdown } from '../../src/pipeline/index.js';

const SAMPLE = `---
title: "Mergex Services"
source_url: "https://mergex.co/services"
scraped_at: "2026-06-26T10:00:00Z"
word_count: 280
description: "Growth services for B2B SaaS companies"
---

# Our Services

> **Source:** https://mergex.co/services
> **Scraped:** Jun 26, 2026

Mergex offers three core services for ambitious B2B SaaS teams. Each is designed to move the needle on revenue without adding unnecessary headcount.

## Growth Diagnostic

The Growth Diagnostic is a 4-week intensive. We map every revenue lever — acquisition, activation, retention, expansion — against benchmarks from 200+ comparable companies.

![OVRN Diagnostic Framework — four phases: Discovery, Mapping, Benchmarking, Roadmap](https://mergex.co/assets/ovrn-framework.png)

Deliverable: a 40-page report with prioritised recommendations and a 90-day playbook.

## Revenue Operations

![](https://mergex.co/assets/icon-ops.svg)

We audit your CRM, attribution, and reporting stack. Most clients discover 15–30% of pipeline is misattributed or invisible. We fix the plumbing so your numbers are trustworthy.

## Fractional Growth Leadership

Need a Head of Growth without the full-time cost? We embed with your team 2 days/week. Shared Slack, weekly syncs, live dashboards.

Back to top
All rights reserved © Mergex 2024
Accept all cookies
`;

console.log('\n🧪 Testing clean-and-chunk pipeline...\n');

const { cleaned, chunks, alerts } = await cleanAndChunkMarkdown(SAMPLE, 'services');

console.log('── ALERTS ──────────────────────────────────────');
for (const a of alerts) {
  const icon = a.type.includes('DROPPED') ? '⚠' : a.type.includes('KEPT') ? '✓' : '⊘';
  console.log(`  ${icon} [${a.type}] ${a.message}`);
}

console.log('\n── STATS ───────────────────────────────────────');
console.log(`  Topics     : ${cleaned.stats.topicCount}`);
console.log(`  Paragraphs : ${cleaned.stats.cleanedParagraphs}`);
console.log(`  Dropped Imgs: ${cleaned.stats.droppedImages}`);
console.log(`  Kept Imgs  : ${cleaned.stats.keptImages}`);

console.log('\n── CHUNKS ──────────────────────────────────────');
for (const c of chunks) {
  const conn = [
    c.parent_id ? `parent=${c.parent_id.split('#')[1]}` : null,
    c.prev_id ? `prev=${c.prev_id.split('#')[1]}` : null,
    c.next_id ? `next=${c.next_id.split('#')[1]}` : null,
    c.children_ids.length ? `children=${c.children_ids.length}` : null,
  ].filter(Boolean).join(', ');

  console.log(`  [${c.index}] ${c.id.padEnd(40)} tokens=${String(c.token_count).padStart(3)} role=${c.graph_role.padEnd(6)} ${conn}`);
}

console.log('\n── CLEANED MARKDOWN ────────────────────────────');
console.log(cleaned.markdown);
