/**
 * process-kb.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Batch processes all *.md files in kb/raw/ through the clean-and-chunk pipeline.
 *
 * USAGE:
 *   node scripts/process-kb.js
 *   node scripts/process-kb.js --input kb/raw --output kb/chunks --dry-run
 *
 * OUTPUT:
 *   kb/chunks/<slug>.clean.md     — human-readable cleaned passages
 *   kb/chunks/<slug>.chunks.json  — graph-linked chunk array
 *   kb/chunks/manifest.json       — full chunk index (all docs combined)
 *   kb/chunks/REPORT.md           — alert summary with all warnings
 */

import fs   from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const inputDir  = argVal(args, '--input')  || 'kb/raw';
const outputDir = argVal(args, '--output') || 'kb/chunks';
const dryRun    = args.includes('--dry-run');

function argVal(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(inputDir)) {
  console.error(`❌ Input directory not found: ${inputDir}`);
  console.error(`   Create it and place raw Jina markdown files there.`);
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

const mdFiles = fs.readdirSync(inputDir)
  .filter(f => f.endsWith('.md'))
  .sort();

if (mdFiles.length === 0) {
  console.error(`⚠ No .md files found in ${inputDir}`);
  process.exit(0);
}

console.log(`\n🚀 KB Processing Pipeline`);
console.log(`   Input : ${inputDir} (${mdFiles.length} files)`);
console.log(`   Output: ${outputDir}`);
if (dryRun) console.log(`   Mode  : DRY RUN — no files written\n`);

const allChunks  = [];
const allAlerts  = [];
const fileStats  = [];

for (const file of mdFiles) {
  const inputPath  = path.join(inputDir, file);
  const baseName   = path.basename(file, '.md');

  console.log(`\n── Processing: ${file}`);

  if (dryRun) {
    console.log(`   [dry-run] would process ${inputPath}`);
    continue;
  }

  try {
    // Capture both stdout (chunks JSON) and stderr (alerts)
    const result = execSync(
      `node scripts/clean-and-chunk.js "${inputPath}" "${outputDir}"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const chunks = JSON.parse(result);
    allChunks.push(...chunks);

    fileStats.push({
      file,
      chunks: chunks.length,
      tokens: chunks.reduce((s, c) => s + c.token_count, 0),
      hasImages: chunks.filter(c => c.has_images).length,
    });

    console.log(`   ✓ ${chunks.length} chunks`);

  } catch (err) {
    // execSync throws on non-zero exit; stderr has the alert details
    const alerts = err.stderr || err.message;
    console.error(`   ❌ FAILED: ${file}`);
    console.error(alerts);

    allAlerts.push({
      file,
      error: err.message.slice(0, 200),
      stderr: (err.stderr || '').slice(0, 500),
    });
  }
}

if (dryRun) {
  console.log('\n[dry-run complete — no output written]');
  process.exit(0);
}

// ─── Write combined manifest ──────────────────────────────────────────────────
const manifest = {
  generated_at: new Date().toISOString(),
  total_chunks: allChunks.length,
  total_docs:   mdFiles.length,
  docs: fileStats,
  chunks: allChunks,
};

fs.writeFileSync(
  path.join(outputDir, 'manifest.json'),
  JSON.stringify(manifest, null, 2)
);

// ─── Write alert report ───────────────────────────────────────────────────────
const reportLines = [
  `# KB Processing Report`,
  `Generated: ${new Date().toISOString()}`,
  ``,
  `## Summary`,
  `- Files processed : ${mdFiles.length}`,
  `- Total chunks    : ${allChunks.length}`,
  `- Total tokens    : ${allChunks.reduce((s, c) => s + c.token_count, 0)}`,
  `- Files with errors: ${allAlerts.length}`,
  ``,
  `## Per-File Stats`,
  ...fileStats.map(s =>
    `- **${s.file}**: ${s.chunks} chunks, ~${s.tokens} tokens${s.hasImages > 0 ? `, ${s.hasImages} chunks with images` : ''}`
  ),
  ``,
  `## Chunk Graph Roles`,
  `- Root chunks (H1 anchors)  : ${allChunks.filter(c => c.graph_role === 'root').length}`,
  `- Branch chunks (H2 parents): ${allChunks.filter(c => c.graph_role === 'branch').length}`,
  `- Leaf chunks (H3/content)  : ${allChunks.filter(c => c.graph_role === 'leaf').length}`,
];

if (allAlerts.length > 0) {
  reportLines.push('', '## ❌ Errors');
  for (const a of allAlerts) {
    reportLines.push(`### ${a.file}`);
    reportLines.push('```');
    reportLines.push(a.stderr || a.error);
    reportLines.push('```');
  }
}

fs.writeFileSync(path.join(outputDir, 'REPORT.md'), reportLines.join('\n'));

// ─── Final summary ────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`✅ KB Processing Complete`);
console.log(`   Chunks   : ${allChunks.length}`);
console.log(`   Tokens   : ${allChunks.reduce((s, c) => s + c.token_count, 0)}`);
console.log(`   Manifest : ${outputDir}/manifest.json`);
console.log(`   Report   : ${outputDir}/REPORT.md`);
console.log(`${'═'.repeat(60)}\n`);