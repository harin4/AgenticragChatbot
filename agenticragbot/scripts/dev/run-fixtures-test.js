import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cleanAndChunkMarkdown } from '../../src/pipeline/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, '../../tests/fixtures');

async function runFixtures() {
  console.log('[test:fixtures] Running offline stateless parsing tests...\n');
  const files = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.md'));
  
  let passed = 0;
  let failed = 0;

  for (const file of files) {
    console.log(`--- Testing fixture: ${file} ---`);
    const filePath = path.join(fixturesDir, file);
    const rawMarkdown = fs.readFileSync(filePath, 'utf8');
    const docId = path.basename(file, '.md');

    try {
      const { chunks, alerts } = await cleanAndChunkMarkdown(rawMarkdown, docId);
      console.log(`  Parsed into ${chunks.length} chunks.`);
      
      // Basic assertions
      for (const chunk of chunks) {
        if (chunk.token_count > 512) {
          throw new Error(`Chunk ${chunk.id} exceeds 512 tokens (${chunk.token_count})`);
        }
        if (!Array.isArray(chunk.heading_path)) {
          throw new Error(`Chunk ${chunk.id} has invalid heading_path`);
        }
      }
      
      // Feature-specific assertions
      if (docId === 'images-alt-edgecase') {
        const keptImages = alerts.filter(a => a.type === 'KEPT_IMAGE');
        const droppedImages = alerts.filter(a => a.type === 'DROPPED_IMAGE');
        if (keptImages.length !== 1) {
          throw new Error(`Expected exactly 1 KEPT_IMAGE alert, got ${keptImages.length}`);
        }
        if (droppedImages.length !== 2) {
          throw new Error(`Expected exactly 2 DROPPED_IMAGE alerts, got ${droppedImages.length}`);
        }
      }

      console.log('  ✅ PASS\n');
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL:`, err.message);
      console.log('\n');
      failed++;
    }
  }

  console.log(`Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runFixtures().catch(err => {
  console.error(err);
  process.exit(1);
});
