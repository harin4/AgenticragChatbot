// jina-pipeline.js
// Run with: node jina-pipeline.js
// Requires Node 18+ (native fetch). No npm installs needed.
//
// Walks your real ingestion pipeline end-to-end, in the same order as your
// architecture diagram:
//   Reader (r.jina.ai)  ->  Segmenter ("AI chunker")  ->  Embeddings  ->  Reranker
//
// Put your key in an env var instead of hardcoding it:
//   export JINA_API_KEY="jina_xxx..."        (mac/linux)
//   $env:JINA_API_KEY="jina_xxx..."          (windows powershell)

const JINA_API_KEY = process.env.JINA_API_KEY;

const PAGE_URL = "https://www.f22labs.com/blogs/what-is-retrieval-augmented-generation-rag/";
const SIMULATED_USER_QUERY = "How does RAG reduce hallucination?";
const MAX_CHUNK_LENGTH = 500;

if (!JINA_API_KEY) {
  console.error("Missing JINA_API_KEY.");
  process.exit(1);
}

const headersJSON = {
  "Authorization": `Bearer ${JINA_API_KEY}`,
  "Content-Type": "application/json",
  "Accept": "application/json",
};

function explain(status) {
  if (status === 401) return "Invalid/expired key. Check for trailing spaces.";
  if (status === 402) return "Out of credits for this product on your Jina account.";
  if (status === 422) return "Payload shape is wrong — field names differ per endpoint (content vs input vs documents).";
  if (status === 429) return "Rate limited — same backoff logic your Cloudflare Worker will need under load.";
  if (status >= 500) return "Jina-side error, not yours. Retry with backoff.";
  return "Check the raw response body printed above for the exact complaint.";
}

async function callJina(label, url, options) {
  console.log(`\n--- ${label} ---`);
  const res = await fetch(url, options);
  const raw = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status}`);
    console.error(raw.slice(0, 800));
    console.error(`Hint: ${explain(res.status)}`);
    throw new Error(`${label} failed with ${res.status}`);
  }
  return JSON.parse(raw);
}

async function main() {
  // 1. Reader — URL -> clean markdown
  const readerJson = await callJina(
    "1. Reader (r.jina.ai)",
    `https://r.jina.ai/${PAGE_URL}`,
    { headers: { "Authorization": `Bearer ${JINA_API_KEY}`, "Accept": "application/json" } }
  );
  const pageText = readerJson.data?.content || "";
  console.log("title:", readerJson.data?.title);
  console.log("content length:", pageText.length, "chars");
  console.log("preview:", pageText.slice(0, 300));

  // 2. Segmenter — semantic chunking
  const segJson = await callJina(
    "2. Segmenter (semantic chunker)",
    "https://api.jina.ai/v1/segment",
    {
      method: "POST",
      headers: headersJSON,
      body: JSON.stringify({
        content: pageText,
        return_chunks: true,
        max_chunk_length: MAX_CHUNK_LENGTH,
      }),
    }
  );
  const chunks = segJson.chunks || [];
  console.log("chunks returned:", chunks.length);
  chunks.slice(0, 3).forEach((c, i) => console.log(`  chunk ${i + 1} (${c.length}c):`, c.slice(0, 100), "..."));

  // pick a few chunks to carry forward, same as the rest of your pipeline would
  const selectedChunks = chunks.slice(0, Math.min(5, chunks.length));

  // 3. Embeddings — chunks -> vectors
  const embJson = await callJina(
    "3. Embeddings",
    "https://api.jina.ai/v1/embeddings",
    {
      method: "POST",
      headers: headersJSON,
      body: JSON.stringify({
        model: "jina-embeddings-v3",
        task: "retrieval.passage",
        input: selectedChunks.length ? selectedChunks : [pageText],
      }),
    }
  );
  console.log("vectors returned:", embJson.data?.length);
  console.log("embedding dims:", embJson.data?.[0]?.embedding?.length);
  console.log("usage:", embJson.usage);

  // 4. Reranker — best chunks selected against a query
  const rerankJson = await callJina(
    "4. Reranker",
    "https://api.jina.ai/v1/rerank",
    {
      method: "POST",
      headers: headersJSON,
      body: JSON.stringify({
        model: "jina-reranker-v2-base-multilingual",
        query: SIMULATED_USER_QUERY,
        documents: selectedChunks.length ? selectedChunks : [pageText],
        top_n: Math.min(3, selectedChunks.length || 1),
      }),
    }
  );
  console.log("query:", SIMULATED_USER_QUERY);
  rerankJson.results.forEach((r, i) => {
    // console.log(`  #${i + 1} score=${r.relevance_score.toFixed(4)} ->`, r.document.slice(0, 100), "...");
    const docText = typeof r.document === "string" ? r.document : r.document?.text || "";
    console.log(`  #${i + 1} score=${r.relevance_score.toFixed(4)} ->`, docText.slice(0, 100), "...");
  });

  console.log("\nPipeline complete: Reader -> Segmenter -> Embeddings -> Reranker, matching the architecture diagram end to end.");
}

main().catch((err) => {
  console.error("\nPipeline stopped:", err.message);
  process.exit(1);
});
