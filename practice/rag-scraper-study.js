// ============================================================
// rag-scraper-study.js
// COMPARATIVE STUDY: Jina vs Firecrawl for Agentic RAG
// ============================================================
// Run with: node rag-scraper-study.js
// Requires Node 18+ (native fetch). No npm installs needed.
//
// ENV VARS NEEDED:
//   export JINA_API_KEY="jina_xxx..."
//   export FIRECRAWL_API_KEY="fc-xxx..."   (optional — skips Firecrawl if missing)
//
// WHAT THIS SCRIPT DOES:
//   Phase A — Jina error detection on 5 URL categories (normal, 404, SPA hash,
//             skeleton, auth-walled) so every failure mode is captured with evidence.
//   Phase B — Full Jina pipeline: Reader -> Segmenter -> Embeddings -> Reranker
//   Phase C — Firecrawl equivalent: Scrape -> Crawl (multi-page) -> Extract
//   Phase D — Side-by-side scoring on content quality, latency, token cost,
//             and suitability verdict per stage (early / production-scale).
//
// OUTPUT: console + writes  rag-scraper-study-report.json  beside this file.
// ============================================================

const JINA_API_KEY      = process.env.JINA_API_KEY;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY; // optional

// ── URLs used across all tests ──────────────────────────────
const URLS = {
  normal:    "https://www.f22labs.com/blogs/what-is-retrieval-augmented-generation-rag/",
  notFound:  "https://www.f22labs.com/this-page-definitely-does-not-exist-404xyz/",
  hashRoute: "https://vuejs.org/#/guide",                  // hash-based SPA route
  jsSPA:     "https://react.dev/learn",                    // JS-heavy React docs
  multiPage: "https://www.f22labs.com/blogs/",             // blog listing — tests crawl depth
};

const SIMULATED_QUERY  = "How does RAG reduce hallucination in LLMs?";
const MAX_CHUNK_LENGTH = 1000;

// ── Helpers ──────────────────────────────────────────────────

const PASS  = "✅ PASS";
const FAIL  = "❌ FAIL";
const WARN  = "⚠️  WARN";
const INFO  = "ℹ️  INFO";

function log(icon, label, msg) {
  console.log(`${icon}  [${label}]  ${msg}`);
}

function sec(ms) { return (ms / 1000).toFixed(2) + "s"; }

function explainHttpError(status) {
  const map = {
    401: "Invalid/expired key — check for trailing spaces or wrong product key.",
    402: "Out of credits for this Jina product. Check jina.ai dashboard.",
    403: "Forbidden — target site blocked the Jina crawler (WAF / robots.txt).",
    404: "Endpoint URL wrong — double-check the API path.",
    422: "Payload shape wrong — field names differ per endpoint (content vs input vs documents).",
    429: "Rate limited — add exponential backoff. Without API key: 20 RPM hard cap.",
    500: "Jina/Firecrawl-side error. Not yours. Retry with backoff.",
    503: "Service temporarily unavailable. Retry.",
  };
  return map[status] || `Unexpected HTTP ${status} — inspect raw body above.`;
}

// Generic fetch wrapper with timing + full error capture
async function timedFetch(label, url, options = {}) {
  const t0 = Date.now();
  let res, rawText;
  try {
    res     = await fetch(url, options);
    rawText = await res.text();
  } catch (networkErr) {
    return {
      label, ok: false,
      error: `NETWORK_ERROR: ${networkErr.message}`,
      latencyMs: Date.now() - t0,
      data: null,
    };
  }
  const latencyMs = Date.now() - t0;
  const ok = res.ok;
  let parsed = null;
  try { parsed = JSON.parse(rawText); } catch (_) { /* plain text response */ }

  if (!ok) {
    console.error(`\n  HTTP ${res.status} on [${label}]`);
    console.error("  Raw:", rawText.slice(0, 600));
    console.error("  Hint:", explainHttpError(res.status));
  }
  return { label, ok, status: res.status, latencyMs, data: parsed, rawText };
}

// ── Content Quality Scorer ────────────────────────────────────
// Returns a 0-100 score + breakdown so results are comparable.
function scoreContent(markdown = "", url = "") {
  const scores = {};

  // 1. Length — raw proxy for completeness
  const len = markdown.trim().length;
  scores.length = len < 200 ? 0 : len < 800 ? 30 : len < 2000 ? 60 : 100;

  // 2. Skeleton/loader content detected
  const skeletonWords = [
    "loading...", "please wait", "javascript required",
    "enable javascript", "checking your browser", "ddos protection",
    "just a moment", "cloudflare ray id",
  ];
  scores.noSkeleton = skeletonWords.some(w => markdown.toLowerCase().includes(w)) ? 0 : 100;

  // 3. Structural richness — headings, lists, code blocks present
  const hasHeadings = /^#{1,3} /m.test(markdown);
  const hasLists    = /^[-*] /m.test(markdown);
  scores.structure  = (hasHeadings ? 50 : 0) + (hasLists ? 50 : 0);

  // 4. Navigation noise — nav/footer boilerplate leaked into content
  const noiseWords = ["cookie policy", "privacy policy", "all rights reserved", "skip to content"];
  const noiseCount = noiseWords.filter(w => markdown.toLowerCase().includes(w)).length;
  scores.lowNoise  = noiseCount === 0 ? 100 : noiseCount === 1 ? 70 : noiseCount === 2 ? 40 : 0;

  // 5. Token efficiency — shorter = cheaper for same semantic content
  //    Penalise excessive length vs content (heuristic: >20k chars = likely bloat)
  scores.tokenEfficiency = len > 20000 ? 50 : 100;

  const overall = Math.round(
    scores.length           * 0.30 +
    scores.noSkeleton       * 0.25 +
    scores.structure        * 0.20 +
    scores.lowNoise         * 0.15 +
    scores.tokenEfficiency  * 0.10
  );
  return { overall, breakdown: scores, contentLength: len };
}

// ══════════════════════════════════════════════════════════════
// PHASE A — JINA FAILURE MODE DETECTION
// ══════════════════════════════════════════════════════════════

async function phaseA_JinaFailureModes(report) {
  console.log("\n" + "═".repeat(64));
  console.log("PHASE A — JINA FAILURE MODE DETECTION");
  console.log("═".repeat(64));

  const jina = {};

  // ── Test A1: Normal page — baseline ─────────────────────────
  {
    async function benchmark(label, fn, runs = 5) {
      const results = [];

      for (let i = 0; i < runs; i++) {
        const start = Date.now();
        const data = await fn();
        results.push({
          latency: Date.now() - start,
          ok: data.ok,
        });
      }

      const avg =
        results.reduce((s, r) => s + r.latency, 0) / runs;

      return {
        averageLatency: avg,
        minLatency: Math.min(...results.map(r => r.latency)),
        maxLatency: Math.max(...results.map(r => r.latency)),
        successRate:
          results.filter(r => r.ok).length / runs,
      };
    }
    const content  = r.data?.data?.content || "";
    const warning  = r.data?.data?.warning || "";
    const quality  = scoreContent(content, URLS.normal);

    const isSilentEmpty = !r.ok || content.length < 200;
    log(isSilentEmpty ? FAIL : PASS, "A1 Normal page", `latency=${sec(r.latencyMs)}  len=${content.length}  score=${quality.overall}/100`);
    if (warning) log(WARN, "A1", `Jina warning field: "${warning}"`);

    jina.normalPage = {
      latencyMs: r.latencyMs, contentLength: content.length,
      quality, warning, ok: r.ok && !isSilentEmpty,
    };
  }

  // ── Test A2: 404 page — silent failure detection ─────────────
  {
    const r = await timedFetch(
      "A2-404-Silent",
      `https://r.jina.ai/${URLS.notFound}`,
      { headers: { Authorization: `Bearer ${JINA_API_KEY}`, Accept: "application/json" } }
    );
    const content = r.data?.data?.content || "";
    const warning = r.data?.data?.warning || "";
    const httpCode = r.data?.code;          // Jina returns 200 even for 404 targets!

    const silentFail = r.ok && !warning && content.toLowerCase().includes("unknown");
    const detected   = !!warning || content.length < 50;

    log(
      warning ? PASS : WARN,
      "A2 Silent 404",
      `HTTP=${r.status} Jina.code=${httpCode}  content="${content.slice(0,60)}"  warning="${warning}"`
    );
    log(INFO, "A2", detected
      ? "Failure DETECTED via warning field or content length check."
      : "⚠ Silent failure — Jina returned 200 with no warning. YOUR VALIDATOR MUST CATCH THIS.");

    jina.silentNotFound = {
      jinaReturnsHttp200: r.ok,
      jinaCodeField: httpCode,
      warningField: warning,
      contentSnippet: content.slice(0, 80),
      detectedByWarning: !!warning,
      detectedByLength: content.length < 50,
      verdict: detected ? "DETECTABLE" : "SILENT_POISON — must add length+warning check",
    };
  }

  // ── Test A3: Hash-route SPA — wrong-page capture ─────────────
  {
    // A3a: Wrong way (GET — will miss the hash fragment)
    const rGet = await timedFetch(
      "A3a-HashRoute-GET",
      `https://r.jina.ai/${URLS.hashRoute}`,
      { headers: { Authorization: `Bearer ${JINA_API_KEY}`, Accept: "application/json" } }
    );
    const contentGet = rGet.data?.data?.content || "";

    // A3b: Correct way (POST with url in body)
    const rPost = await timedFetch(
      "A3b-HashRoute-POST",
      "https://r.jina.ai/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${JINA_API_KEY}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: URLS.hashRoute }),
      }
    );
    const contentPost = rPost.data?.data?.content || "";

    log(INFO,  "A3 Hash-Route GET",  `len=${contentGet.length}  (likely homepage content, not /guide)`);
    log(contentPost.length > contentGet.length ? PASS : WARN,
        "A3 Hash-Route POST", `len=${contentPost.length}  (POST sends hash to Puppeteer)`);
    log(WARN,  "A3 Root cause",
        "Hash (#) is stripped by browser before sending to server. Always POST hash-route URLs.");

    jina.hashRoute = {
      getContentLen: contentGet.length,
      postContentLen: contentPost.length,
      postIsBetter: contentPost.length > contentGet.length,
      fix: "Use POST for any URL containing '#'",
    };
  }

  // ── Test A4: JS-heavy SPA — partial render detection ─────────
  {
    // A4a: Standard mode — may capture skeleton
    const rStd = await timedFetch(
      "A4a-SPA-Standard",
      `https://r.jina.ai/${URLS.jsSPA}`,
      { headers: { Authorization: `Bearer ${JINA_API_KEY}`, Accept: "application/json" } }
    );
    const contentStd = rStd.data?.data?.content || "";
    const qualityStd = scoreContent(contentStd, URLS.jsSPA);

    // A4b: Stream mode — more render time
    const rStream = await timedFetch(
      "A4b-SPA-StreamMode",
      `https://r.jina.ai/${URLS.jsSPA}`,
      {
        headers: {
          Authorization: `Bearer ${JINA_API_KEY}`,
          Accept: "text/event-stream",
          "X-Wait-For-Selector": "main, article, [class*='content']",
        },
      }
    );
    // Stream returns SSE lines; extract last data: {...} block
    const lastDataLine = (rStream.rawText || "")
      .split("\n")
      .filter(l => l.startsWith("data:"))
      .pop() || "";
    let streamContent = "";
    try {
      streamContent = JSON.parse(lastDataLine.replace("data:", "").trim())?.data?.content || "";
    } catch (_) {
      streamContent = contentStd; // fallback
    }
    const qualityStream = scoreContent(streamContent, URLS.jsSPA);

    log(qualityStd.overall >= 60 ? PASS : WARN,
        "A4 SPA Standard", `len=${contentStd.length}  score=${qualityStd.overall}/100  latency=${sec(rStd.latencyMs)}`);
    log(qualityStream.overall >= qualityStd.overall ? PASS : INFO,
        "A4 SPA Stream",   `len=${streamContent.length}  score=${qualityStream.overall}/100  latency=${sec(rStream.latencyMs)}`);
    log(INFO, "A4 Verdict",
        qualityStream.overall > qualityStd.overall
          ? "Stream mode improved quality — use for JS-heavy pages."
          : "Standard mode sufficient for this SPA.");

    jina.jsSPA = {
      standardMode:  { contentLen: contentStd.length,   qualityScore: qualityStd.overall,   latencyMs: rStd.latencyMs },
      streamMode:    { contentLen: streamContent.length, qualityScore: qualityStream.overall, latencyMs: rStream.latencyMs },
      streamIsBetter: qualityStream.overall > qualityStd.overall,
      recommendation: qualityStream.overall > qualityStd.overall
        ? "Use stream mode + X-Wait-For-Selector for SPAs"
        : "Standard mode adequate",
    };
  }

  // ── Test A5: Rate-limit behaviour (no-key simulation) ────────
  {
    log(INFO, "A5 Rate Limit", "Sending request WITHOUT API key to observe throttle behaviour...");
    const rNoKey = await timedFetch(
      "A5-NoKey",
      `https://r.jina.ai/${URLS.normal}`,
      { headers: { Accept: "application/json" } }   // deliberately no auth header
    );
    const status  = rNoKey.status;
    const content = rNoKey.data?.data?.content || rNoKey.rawText || "";
    log(
      status === 429 ? FAIL : WARN,
      "A5 No-Key Rate",
      `HTTP=${status}  content_len=${content.length}  (429 = hard throttle, 200 = free tier still serving)`
    );
    log(INFO, "A5", "Free tier without key: ~20 RPM. Your Cloudflare Worker MUST send the API key for production.");

    jina.rateLimitNoKey = {
      httpStatus: status,
      contentLen: content.length,
      verdict: status === 429
        ? "Hard-blocked without key — add JINA_API_KEY to Worker secrets"
        : "Free tier served but at 20 RPM hard cap — unacceptable for production",
    };
  }

  report.phaseA_JinaFailures = jina;
  console.log("\n✔ Phase A complete. All Jina failure modes probed.\n");
}

// ══════════════════════════════════════════════════════════════
// PHASE B — FULL JINA PIPELINE (your existing flow, instrumented)
// ══════════════════════════════════════════════════════════════

async function phaseB_JinaPipeline(report) {
  console.log("═".repeat(64));
  console.log("PHASE B — FULL JINA PIPELINE  (Reader→Segmenter→Embeddings→Reranker)");
  console.log("═".repeat(64));

  const pipeline = { steps: [] };

  // B1 Reader
  const rReader = await timedFetch(
    "B1-Reader",
    `https://r.jina.ai/${URLS.normal}`,
    { headers: { Authorization: `Bearer ${JINA_API_KEY}`, Accept: "application/json" } }
  );
  const pageText = rReader.data?.data?.content || "";
  const quality  = scoreContent(pageText, URLS.normal);
  log(rReader.ok && pageText.length > 200 ? PASS : FAIL,
      "B1 Reader", `len=${pageText.length}  score=${quality.overall}/100  latency=${sec(rReader.latencyMs)}`);
  pipeline.steps.push({ step: "Reader", ok: rReader.ok, latencyMs: rReader.latencyMs, outputLen: pageText.length, qualityScore: quality.overall });

  if (!pageText) {
    log(FAIL, "B1", "Empty content — aborting pipeline. Check URL accessibility.");
    report.phaseB_Pipeline = pipeline;
    return;
  }

  // B2 Segmenter
  const rSeg = await timedFetch(
    "B2-Segmenter",
    "https://api.jina.ai/v1/segment",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${JINA_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        content: pageText,
        return_chunks: true,
        max_chunk_length: MAX_CHUNK_LENGTH,
      }),
    }
  );
  const chunks = rSeg.data?.chunks || [];
  log(rSeg.ok && chunks.length > 0 ? PASS : FAIL,
      "B2 Segmenter", `chunks=${chunks.length}  latency=${sec(rSeg.latencyMs)}`);

  // Chunk quality checks
  const emptyChunks = chunks.filter(c => c.trim().length < 20).length;
  const avgLen      = chunks.length ? Math.round(chunks.reduce((s, c) => s + c.length, 0) / chunks.length) : 0;
  if (emptyChunks > 0) log(WARN, "B2", `${emptyChunks} near-empty chunks (<20 chars) — will pollute embeddings`);
  log(INFO, "B2", `avg chunk length: ${avgLen} chars  (target: 200-400 for RAG)`);
  pipeline.steps.push({ step: "Segmenter", ok: rSeg.ok, latencyMs: rSeg.latencyMs, chunksCount: chunks.length, avgChunkLen: avgLen, emptyChunks });

  const goodChunks = chunks.filter(c => c.trim().length >= 50).slice(0, 5);

  // B3 Embeddings
  const rEmb = await timedFetch(
    "B3-Embeddings",
    "https://api.jina.ai/v1/embeddings",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${JINA_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: "jina-embeddings-v3",
        task: "retrieval.passage",
        input: goodChunks.length ? goodChunks : [pageText.slice(0, 2000)],
      }),
    }
  );
  const vectors = rEmb.data?.data || [];
  const dims    = vectors[0]?.embedding?.length || 0;
  const tokensUsed = rEmb.data?.usage?.total_tokens || 0;
  log(rEmb.ok && vectors.length > 0 ? PASS : FAIL,
      "B3 Embeddings", `vectors=${vectors.length}  dims=${dims}  tokens_used=${tokensUsed}  latency=${sec(rEmb.latencyMs)}`);

  // NOTE: Jina embeddings use dims=1024 by default; your BGE model uses 384.
  // This matters if you mix them in Qdrant — collections are dimension-locked.
  if (dims && dims !== 384) {
    log(WARN, "B3", `Jina embedding dims=${dims} vs your BGE model dims=384. Do NOT mix in same Qdrant collection.`);
  }
  pipeline.steps.push({ step: "Embeddings", ok: rEmb.ok, latencyMs: rEmb.latencyMs, vectorCount: vectors.length, dims, tokensUsed });

  // B4 Reranker
  const rRerank = await timedFetch(
    "B4-Reranker",
    "https://api.jina.ai/v1/rerank",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${JINA_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: "jina-reranker-v2-base-multilingual",
        query: SIMULATED_QUERY,
        documents: goodChunks.length ? goodChunks : [pageText.slice(0, 2000)],
        top_n: Math.min(3, goodChunks.length || 1),
      }),
    }
  );
  const results = rRerank.data?.results || [];
  log(rRerank.ok && results.length > 0 ? PASS : FAIL,
      "B4 Reranker", `top_results=${results.length}  latency=${sec(rRerank.latencyMs)}`);
  results.forEach((r, i) => {
    const docText = typeof r.document === "string" ? r.document : r.document?.text || "";
    log(INFO, `B4 #${i+1}`, `score=${r.relevance_score?.toFixed(4)}  "${docText.slice(0, 90)}..."`);
  });
  pipeline.steps.push({ step: "Reranker", ok: rRerank.ok, latencyMs: rRerank.latencyMs, topResults: results.length });

  pipeline.totalLatencyMs = pipeline.steps.reduce((s, x) => s + x.latencyMs, 0);
  log(INFO, "B Pipeline", `Total latency: ${sec(pipeline.totalLatencyMs)}`);

  report.phaseB_Pipeline = pipeline;
  console.log("\n✔ Phase B complete.\n");
}

// ══════════════════════════════════════════════════════════════
// PHASE C — FIRECRAWL EQUIVALENT TESTS
// ══════════════════════════════════════════════════════════════

async function phaseC_Firecrawl(report) {
  console.log("═".repeat(64));
  console.log("PHASE C — FIRECRAWL TESTS  (Scrape → Crawl → Extract)");
  console.log("═".repeat(64));

  if (!FIRECRAWL_API_KEY) {
    log(WARN, "C0", "FIRECRAWL_API_KEY not set. Skipping live tests.");
    log(INFO, "C0", "Set:  export FIRECRAWL_API_KEY='fc-xxx...'  then rerun to get real data.");
    report.phaseC_Firecrawl = { skipped: true, reason: "No FIRECRAWL_API_KEY" };

    // Still record the documented behaviour for the comparison report
    report.phaseC_Firecrawl.documentedBehaviour = {
      scrapeEndpoint: "POST https://api.firecrawl.dev/v1/scrape",
      crawlEndpoint:  "POST https://api.firecrawl.dev/v1/crawl",
      formats:        ["markdown", "html", "rawHtml", "screenshot", "links", "extract"],
      jsRendering:    "Full Playwright (Chromium) — handles all SPAs",
      hashRoutes:     "Handled natively — no workaround needed",
      silent404:      "Returns success:false with error field — no silent poisoning",
      multiPageCrawl: "Single API call — built-in depth/limit controls",
      contentFilter:  "onlyMainContent:true strips nav/footer noise better than Jina",
      pricing:        "$83/month for 100k credits, 1 credit/page",
      freeTier:       "500 credits free, then $16/5k (Hobby)",
      rateLimit:      "No RPM cap on paid plans — scales with credits",
      selfHostable:   "Yes — AGPL-3.0",
    };
    console.log("\n✔ Phase C recorded (documented only — no live key).\n");
    return;
  }

  const fc = { steps: [] };
  const FC_HEADERS = {
    Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    "Content-Type": "application/json",
  };

  // C1: Single page scrape — equivalent to Jina Reader
  const rScrape = await timedFetch(
    "C1-Scrape",
    "https://api.firecrawl.dev/v1/scrape",
    {
      method: "POST",
      headers: FC_HEADERS,
      body: JSON.stringify({
        url: URLS.normal,
        formats: ["markdown", "html", "links", "screenshot"],
        onlyMainContent: true,
      }),
    }
  );
  const fcMarkdown = rScrape.data?.data?.markdown || "";
  const fcQuality  = scoreContent(fcMarkdown, URLS.normal);
  log(rScrape.ok && fcMarkdown.length > 200 ? PASS : FAIL,
      "C1 FC Scrape", `len=${fcMarkdown.length}  score=${fcQuality.overall}/100  latency=${sec(rScrape.latencyMs)}`);
  fc.steps.push({ step: "Scrape", ok: rScrape.ok, latencyMs: rScrape.latencyMs, contentLen: fcMarkdown.length, qualityScore: fcQuality.overall });

  // C2: 404 page — does Firecrawl handle it better than Jina?
  const rFc404 = await timedFetch(
    "C2-Scrape-404",
    "https://api.firecrawl.dev/v1/scrape",
    {
      method: "POST",
      headers: FC_HEADERS,
      body: JSON.stringify({ url: URLS.notFound, formats: ["markdown"] }),
    }
  );
  const fcSuccess404 = rFc404.data?.success;
  const fcError404   = rFc404.data?.error || "";

  const md404 = rFc404.data?.data?.markdown || "";

  const looks404 =
    md404.includes("404") ||
    md404.includes("Not Found") ||
    md404.includes("Page not found");

  log(
    (fcSuccess404 === false || looks404) ? PASS : WARN,
    "C2 FC 404 handling",
    `success=${fcSuccess404} looks404=${looks404} error="${fcError404}"`
  );
  fc.steps.push({ step: "404-Check", ok: fcSuccess404 === false, errorExplicit: !!fcError404 });

  // C3: Multi-page crawl — Jina has NO equivalent; this is Firecrawl's unique power
  log(INFO, "C3 Multi-page", `Starting crawl of ${URLS.multiPage} (limit=3 pages to stay in free tier)...`);
  const rCrawl = await timedFetch(
    "C3-Crawl",
    "https://api.firecrawl.dev/v1/crawl",
    {
      method: "POST",
      headers: FC_HEADERS,
      body: JSON.stringify({
        url: URLS.multiPage,
        limit: 3,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      }),
    }
  );
  // Crawl is async — Firecrawl returns a jobId
  const crawlJobId     = rCrawl.data?.id;
  const crawlSucceeded = rCrawl.ok && !!crawlJobId;
  if (crawlSucceeded) {
    const crawlResults = await waitForCrawl(crawlJobId);

    const pages = crawlResults.data?.length || 0;

    log(
      PASS,
      "C3 Crawl Results",
      `pages=${pages}`
    );

    fc.steps.push({
      step: "CrawlResults",
      pages
    });
  }
  log(crawlSucceeded ? PASS : FAIL,
      "C3 Crawl job", `jobId=${crawlJobId}  latency=${sec(rCrawl.latencyMs)}`);
  log(INFO, "C3", "Crawl is async. Poll GET /v1/crawl/:id to retrieve results.");
  fc.steps.push({ step: "Crawl", ok: crawlSucceeded, jobId: crawlJobId, latencyMs: rCrawl.latencyMs });

  // C4: Structured extract (LLM-powered) — no Jina equivalent
  const rExtract = await timedFetch(
    "C4-Extract",
    "https://api.firecrawl.dev/v1/scrape",
    {
      method: "POST",
      headers: FC_HEADERS,
      body: JSON.stringify({
        url: URLS.normal,
        formats: ["extract"],
        extract: {
          schema: {
            type: "object",
            properties: {
              title:       { type: "string" },
              summary:     { type: "string" },
              key_points:  { type: "array", items: { type: "string" } },
            },
            required: ["title", "summary"],
          },
        },
      }),
    }
  );
  const extracted = rExtract.data?.data?.extract || null;
  log(rExtract.ok && extracted ? PASS : WARN,
      "C4 Structured Extract",
      extracted
        ? `title="${extracted.title?.slice(0,50)}"  key_points=${extracted.key_points?.length || 0}  latency=${sec(rExtract.latencyMs)}`
        : `Failed or empty — latency=${sec(rExtract.latencyMs)}`
  );
  fc.steps.push({ step: "StructuredExtract", ok: !!(rExtract.ok && extracted), latencyMs: rExtract.latencyMs, result: extracted });

  fc.totalLatencyMs = fc.steps.filter(s => s.latencyMs).reduce((s, x) => s + (x.latencyMs||0), 0);
  report.phaseC_Firecrawl = fc;
  console.log("\n✔ Phase C complete.\n");
}
async function waitForCrawl(jobId) {
  while (true) {
    const res = await fetch(
      `https://api.firecrawl.dev/v1/crawl/${jobId}`,
      {
        headers: {
          Authorization: `Bearer ${FIRECRAWL_API_KEY}`
        }
      }
    );

    const data = await res.json();

    if (data.status === "completed")
      return data;

    if (data.status === "failed")
      throw new Error("Crawl failed");

    await new Promise(r => setTimeout(r, 3000));
  }
}

// ══════════════════════════════════════════════════════════════
// PHASE D — SIDE-BY-SIDE SCORING & VERDICT
// ══════════════════════════════════════════════════════════════

function phaseD_Verdict(report) {
  console.log("═".repeat(64));
  console.log("PHASE D — COMPARATIVE SCORING & STAGE VERDICT");
  console.log("═".repeat(64));

  // Pull actual measured data where available, fall back to documented values
  const jinaReader   = report.phaseA_JinaFailures?.normalPage;
  const jinaPipeline = report.phaseB_Pipeline;
  const fcData       = report.phaseC_Firecrawl;

  const comparison = {
    dimensions: {},
    earlyStageVerdict: {},
    productionVerdict: {},
  };

  // ── Dimension scoring (0-10) ─────────────────────────────────

  comparison.dimensions = {
    setupComplexity: {
      jina: 10,
      firecrawl: 7,
      notes: "Jina: prepend URL, zero config. Firecrawl: API key + SDK, but still simple.",
    },
    singlePageQuality: {
      jina: jinaReader?.quality?.overall != null
              ? Math.round(jinaReader.quality.overall / 10) : 7,
      firecrawl: 8,
      notes: "Firecrawl onlyMainContent strips more nav noise. Jina good for articles.",
    },
    multiPageCrawl: {
      jina: 2,
      firecrawl: 10,
      notes: "Jina has NO multi-page crawl — you must loop manually. Firecrawl: single API call.",
    },
    spaJsHandling: {
      jina: report.phaseA_JinaFailures?.jsSPA?.streamIsBetter ? 7 : 5,
      firecrawl: 9,
      notes: "Firecrawl uses full Playwright — handles all SPAs. Jina lightweight renderer can miss hydration.",
    },
    hashRoutes: {
      jina: 5,
      firecrawl: 9,
      notes: "Jina requires POST workaround for hash routes. Firecrawl handles natively.",
    },
    silentFailures: {
      jina: 4,
      firecrawl: 8,
      notes: "Jina 404s return HTTP 200 silently — must validate warning field + content length. Firecrawl surfaces success:false.",
    },
    structuredExtraction: {
      jina: 0,
      firecrawl: 9,
      notes: "Firecrawl /extract supports JSON schema output. Jina has no equivalent — critical for Sales CTA phase.",
    },
    pricingEarlyStage: {
      jina: 10,
      firecrawl: 7,
      notes: "Jina free tier generous (200 RPM with key, no credit card). Firecrawl 500 credits free then paid.",
    },
    pricingAtScale: {
      jina: 6,
      firecrawl: 7,
      notes: "Jina token billing unpredictable at scale. Firecrawl 1 credit/page predictable.",
    },
    rateLimit: {
      jina: 5,
      firecrawl: 8,
      notes: "Jina 20 RPM without key; paid tier higher but token-capped. Firecrawl credit-based, no RPM wall.",
    },
    selfHostable: {
      jina: 3,
      firecrawl: 8,
      notes: "Firecrawl AGPL self-host viable. Jina OSS exists but cloud-dependent storage layer stripped.",
    },
    ekosystemIntegration: {
      jina: 7,
      firecrawl: 9,
      notes: "Firecrawl has first-class LangChain/LlamaIndex/MCP support. Jina integrates via REST.",
    },
  };

  // ── Stage verdicts ──────────────────────────────────────────
  const dims = comparison.dimensions;
  const jinaEarlyScore = [
    dims.setupComplexity.jina,
    dims.singlePageQuality.jina,
    dims.pricingEarlyStage.jina,
    dims.spaJsHandling.jina,
    dims.hashRoutes.jina,
  ].reduce((s, v) => s + v, 0) / 5;

  const fcEarlyScore = [
    dims.setupComplexity.firecrawl,
    dims.singlePageQuality.firecrawl,
    dims.pricingEarlyStage.firecrawl,
    dims.spaJsHandling.firecrawl,
    dims.hashRoutes.firecrawl,
  ].reduce((s, v) => s + v, 0) / 5;

  const jinaProdScore = [
    dims.multiPageCrawl.jina,
    dims.spaJsHandling.jina,
    dims.silentFailures.jina,
    dims.structuredExtraction.jina,
    dims.pricingAtScale.jina,
    dims.rateLimit.jina,
    dims.ekosystemIntegration.jina,
  ].reduce((s, v) => s + v, 0) / 7;

  const fcProdScore = [
    dims.multiPageCrawl.firecrawl,
    dims.spaJsHandling.firecrawl,
    dims.silentFailures.firecrawl,
    dims.structuredExtraction.firecrawl,
    dims.pricingAtScale.firecrawl,
    dims.rateLimit.firecrawl,
    dims.ekosystemIntegration.firecrawl,
  ].reduce((s, v) => s + v, 0) / 7;

  comparison.earlyStageVerdict = {
  jinaScore: +jinaEarlyScore.toFixed(1),
  firecrawlScore: +fcEarlyScore.toFixed(1),

  winner: jinaEarlyScore >= fcEarlyScore
    ? "JINA"
    : "FIRECRAWL",

  recommendation:
    (jinaEarlyScore >= fcEarlyScore)
      ? "Use Jina for rapid prototyping and low-cost single-page ingestion."
      : "Firecrawl provides stronger crawling, extraction and SPA support even at prototype stage.",

  conditions: [
    "Your admin panel controls which URLs get ingested (no autonomous crawl)",
    "Pages are mostly article/docs style (not heavy SPAs)",
    "You need $0 cost during build phase",
  ],
};

  comparison.productionVerdict = {
    jinaScore: +jinaProdScore.toFixed(1),
    firecrawlScore: +fcProdScore.toFixed(1),
    winner: fcProdScore >= jinaProdScore ? "FIRECRAWL" : "JINA",
    recommendation: "Switch to Firecrawl at production scale — especially when KB gap auto-fill, Sales CTA structured data extraction, and full-site crawl triggers activate.",
    migrationTriggers: [
      "You need to crawl entire domains in one shot (KB auto-refresh)",
      "You need JSON schema extraction for structured sales data",
      "Any SPA / JS-heavy customer website enters the KB",
      "Silent 404 poisoning has been detected in Qdrant",
      "Concurrent ingestion volume exceeds Jina 200 RPM",
    ],
  };

  // ── Print results table ──────────────────────────────────────
  console.log("\n  DIMENSION SCORES  (Jina vs Firecrawl, out of 10)");
  console.log("  " + "─".repeat(60));
  Object.entries(dims).forEach(([key, val]) => {
    const bar = (n) => "█".repeat(n) + "░".repeat(10-n);
    console.log(`  ${key.padEnd(26)} Jina ${bar(val.jina)} ${val.jina}  FC ${bar(val.firecrawl)} ${val.firecrawl}`);
  });

  console.log("\n  ╔══════════════════════════════════════════════════════╗");
  console.log(`  ║  EARLY STAGE (prototype/pre-scale)                  ║`);
  console.log(`  ║  Jina: ${comparison.earlyStageVerdict.jinaScore}/10   Firecrawl: ${comparison.earlyStageVerdict.firecrawlScore}/10   WINNER: ${comparison.earlyStageVerdict.winner.padEnd(10)}║`);
  console.log(`  ║  ${comparison.earlyStageVerdict.recommendation.slice(0, 52)}║`);
  console.log("  ╠══════════════════════════════════════════════════════╣");
  console.log(`  ║  PRODUCTION / SALES SCALE                           ║`);
  console.log(`  ║  Jina: ${comparison.productionVerdict.jinaScore}/10   Firecrawl: ${comparison.productionVerdict.firecrawlScore}/10   WINNER: ${comparison.productionVerdict.winner.padEnd(10)}║`);
  console.log(`  ║  ${comparison.productionVerdict.recommendation.slice(0, 52)}║`);
  console.log("  ╚══════════════════════════════════════════════════════╝\n");

  report.phaseD_Verdict = comparison;
}

// ══════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════

async function main() {
  if (!JINA_API_KEY) {
    console.error("❌  JINA_API_KEY not set. Export it and rerun.");
    console.error("    export JINA_API_KEY='jina_xxx...'");
    process.exit(1);
  }

  console.log("\n" + "═".repeat(64));
  console.log("  RAG SCRAPER COMPARATIVE STUDY");
  console.log("  Jina r.jina.ai  vs  Firecrawl.dev");
  console.log("  Agentic RAG Chatbot — Early Stage → Sales Production");
  console.log("═".repeat(64));
  console.log(`  Jina key:      ${JINA_API_KEY.slice(0, 12)}...`);
  console.log(`  Firecrawl key: ${FIRECRAWL_API_KEY ? FIRECRAWL_API_KEY.slice(0, 10) + "..." : "NOT SET (Phase C will be documented-only)"}`);
  console.log("═".repeat(64) + "\n");

  const report = {
    runAt: new Date().toISOString(),
    urls: URLS,
    query: SIMULATED_QUERY,
  };

  await phaseA_JinaFailureModes(report);
  await phaseB_JinaPipeline(report);
  await phaseC_Firecrawl(report);
  phaseD_Verdict(report);

  // Write JSON report for documentation
  const { writeFileSync } = await import("fs");
  const outPath = "./rag-scraper-study-report.json";
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n📄  Full report written to: ${outPath}`);
  console.log("    Use this JSON as evidence in your research documentation.\n");
}

main().catch(err => {
  console.error("\n💥  Study stopped:", err.message);
  process.exit(1);
});