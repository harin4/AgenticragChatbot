/**
 * scripts/test-jina.js
 * Quick local test to verify Jina API is working.
 * Run BEFORE deploying the Worker.
 *
 * Usage:
 *   export JINA_API_KEY="jina_xxxx"
 *   node scripts/test-jina.js https://example.com
 */

const targetUrl = process.argv[2] || 'https://example.com';
const JINA_API_KEY = process.env.JINA_API_KEY;

console.log(`\n🔍  Testing Jina AI Reader API`);
console.log(`    URL: ${targetUrl}`);
console.log(`    API Key: ${JINA_API_KEY ? '✅ set' : '⚠️  not set (rate limited to 20 req/min)'}\n`);

async function testJina() {
  const jinaUrl = `https://r.jina.ai/${targetUrl}`;
  const headers = {
    'Accept': 'application/json',
    'X-Return-Format': 'markdown',
    'X-Timeout': '30'
  };

  if (JINA_API_KEY) {
    headers['Authorization'] = `Bearer ${JINA_API_KEY}`;
  }

  console.log(`📡  Calling: ${jinaUrl}`);
  const start = Date.now();

  const res = await fetch(jinaUrl, { headers });
  const elapsed = Date.now() - start;

  console.log(`    Status: ${res.status} (${elapsed}ms)`);

  if (!res.ok) {
    const text = await res.text();
    console.error(`❌  Jina error: ${text}`);
    process.exit(1);
  }

  const data = await res.json();
  const content = data.data?.content || '';
  const title = data.data?.title || '';

  console.log(`\n📄  Title:    ${title}`);
  console.log(`    Chars:    ${content.length}`);
  console.log(`    Words:    ${content.split(/\s+/).length}`);
  console.log(`\n--- Markdown preview (first 500 chars) ---\n`);
  console.log(content.slice(0, 500));
  console.log(`\n--- End preview ---`);
  console.log(`\n✅  Jina is working! Ready to integrate with the Worker.\n`);
}

testJina().catch(err => {
  console.error('❌  Test failed:', err.message);
  process.exit(1);
});