# KB Formation Worker — Layer 1 (Ingestion Layer)

This is the **Ingestion layer** from your architecture diagram, fully built:

```
Website / Sitemap  →  Jina Reader (r.jina.ai)  →  Clean Markdown
                                                        │
                                          ┌─────────────┴─────────────┐
                                          ▼                           ▼
                                 Cloudflare R2                    Neon (Postgres)
                              (markdown files, in              (job tracking +
                               folder-style keys)               doc metadata)
```

It does NOT include the AI Chunker, embeddings, Qdrant, or the query/RAG side —
that's Layer 2+ (Processing layer in the diagram). This worker's only job is:
**discover pages → scrape to clean markdown → save the "document folder" → log it.**

---

## What was wrong with the uploaded files (fixed already)

1. **`index.js` imported `./utils.js`, but the file was named `util.js`.**
   This would have thrown a "module not found" error the instant you ran
   `wrangler dev` or deployed. Fixed by renaming to `utils.js`.

2. **`deleteR2Document` signature mismatch.** `index.js` called
   `deleteR2Document(env, meta.r2_key)` — passing the actual R2 object key —
   but `storage.js` expected a `docId` and tried to find the matching key by
   scanning the *entire bucket's* metadata. Since the value passed was already
   the key, that scan would never match, and every delete would fail with
   "Document not found in R2" even for documents that existed. Fixed: it now
   deletes directly by the R2 key (faster too — no bucket scan needed).

3. **Folder structure didn't match `wrangler.toml` / `package.json`.**
   Both configs pointed to `src/index.js` and `scripts/init-db.js`, but all
   files were sitting flat in the root. `wrangler dev` would have failed to
   find the entry point. Fixed: everything is now organized into `src/` and
   `scripts/` as the configs expect.

Everything else in your original code — the sitemap-first crawler with
robots.txt parsing and recursive-link-crawl fallback, the Jina retry/backoff
logic, the R2 key scheme (`kb/<domain>/<slug>/<docId>.md`), and the Neon
schema — was already solid. I kept the logic as-is.

---

## Folder structure (what's in this zip)

```
agenticragbot/
├── src/
│   ├── index.js      # Routes + the runCrawlJob orchestrator
│   ├── crawler.js     # Sitemap discovery + robots.txt + fallback link crawl
│   ├── jina.js         # Calls r.jina.ai, builds clean markdown w/ front matter
│   ├── storage.js     # R2 save/get/list/delete
│   ├── db.js           # Neon: schema, job tracking, doc metadata
│   └── utils.js       # CORS + JSON response helpers
├── scripts/
│   ├── init-db.js     # One-time: creates Neon tables (run locally)
│   └── test-jina.js   # One-time: sanity-checks your Jina key before deploying
├── package.json
├── wrangler.toml
├── .dev.vars.example  # Copy to .dev.vars for local secrets (gitignored)
└── .gitignore
```

---

## Setup (step by step)

### 1. Install dependencies
```bash
npm install
```

### 2. Create the R2 bucket
```bash
npx wrangler login
npx wrangler r2 bucket create kb-storage
```
(`wrangler.toml` already binds this bucket to `env.KB_BUCKET`.)

### 3. Set up Neon
- Create a project at https://neon.tech (you said they've already given you access).
- Copy the **pooled** connection string from the dashboard.
- Run the schema setup once, locally:
```bash
export DATABASE_URL="postgresql://...your-neon-url..."
npm run db:init
```

### 4. Get a Jina API key (optional but recommended)
Free tier without a key = 20 requests/min. With a free key from
https://jina.ai/reader, you get 500 requests/min. For crawling a real site,
get the key.

### 5. Local secrets for `wrangler dev`
```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars and paste in your real JINA_API_KEY and DATABASE_URL
```

### 6. Sanity-check Jina before going further
```bash
export JINA_API_KEY="jina_xxxx"
node scripts/test-jina.js https://example.com
```
This should print a markdown preview. If this fails, nothing downstream will work — fix this first.

### 7. Run locally
```bash
npm run dev
```

### 8. Deploy
```bash
# Set production secrets (NOT in wrangler.toml — these are encrypted, not committed)
npx wrangler secret put JINA_API_KEY
npx wrangler secret put DATABASE_URL

npm run deploy
```

---

## API endpoints

| Method | Path              | Purpose |
|--------|-------------------|---------|
| POST   | `/crawl`          | Start a crawl job: `{ "url": "https://example.com", "maxPages": 50 }` |
| GET    | `/jobs/:id`       | Poll job status (running → processing → completed) |
| GET    | `/kb/list`        | List saved documents (optionally `?jobId=...`) |
| GET    | `/kb/doc/:id`     | Fetch one document's markdown content from R2 |
| DELETE | `/kb/doc/:id`     | Delete a document from R2 + Neon |
| POST   | `/init`           | Create Neon tables remotely (alternative to step 3) |
| GET    | `/health`         | Health check |

### Example: kick off a crawl
```bash
curl -X POST https://kb-formation.<your-subdomain>.workers.dev/crawl \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "maxPages": 30}'
```
Returns a `jobId` immediately — the actual crawl runs in the background via
`ctx.waitUntil()`, so the HTTP response doesn't block on every page being scraped.

### Example: check progress
```bash
curl https://kb-formation.<your-subdomain>.workers.dev/jobs/<jobId>
```

---

## How page discovery works (the "sitemap → walkthrough" part you asked for)

`crawler.js` tries things in this order, falling back only if the previous step finds nothing:

1. **robots.txt** — fetched first, both to find `Sitemap:` hints and to respect
   any `Disallow:` rules (so you don't scrape admin/login/cart pages).
2. **Common sitemap paths** — `/sitemap.xml`, `/sitemap_index.xml`,
   `/wp-sitemap.xml`, etc. If it's a sitemap *index* (a sitemap of
   sitemaps — common on big sites), it recurses into up to 15 sub-sitemaps.
3. **Recursive link crawl (fallback)** — if no sitemap exists at all, it
   starts at your given URL, fetches the HTML, extracts same-origin `<a href>`
   links, and does a breadth-first crawl up to `maxPages`, skipping binary
   assets, tracking-param URLs, and admin/auth paths.

Every URL found goes through the same `isContentUrl` filter and gets
deduplicated + capped at `maxPages` before any Jina calls happen — so you're
not wasting Jina quota on garbage URLs.

---

## How "TEXT → DOCUMENT (FOLDER)" works

Each scraped page becomes one markdown file in R2 at:
```
kb/<domain-with-dashes>/<url-slug>/<docId>.md
```
e.g. `kb/example-com/about-us/3f9a1c20-....md`

R2 doesn't have real folders, but it treats `/` in keys as a folder
hierarchy in the dashboard and in `list({ prefix })` calls — so this gives
you a genuine browsable folder structure per domain/page, which is what your
diagram's "Document (folder)" step needs. Each file's front matter (YAML)
also stores `title`, `source_url`, `scraped_at`, and `word_count`, so the
document is self-describing even outside the database.

Neon then stores the *pointer* metadata (`kb_documents` table: id, url,
title, r2_key, char/word counts, timestamps) — Neon doesn't hold the
markdown itself, just where to find it in R2 and what job it came from. This
split (blobs in R2, metadata in Postgres) is exactly why your diagram shows
both a "Data layer" box for Neon and separate R2/Qdrant boxes — cheap object
storage for bulk text, relational DB for fast queries/joins on metadata.

---

## Talking points for your mentor check-in

If asked to defend design decisions on this layer specifically:

- **Why sitemap-first, not just crawl everything?** Sitemaps are
  authoritative — the site owner is telling you exactly what's indexable.
  It's faster (one or a few XML fetches vs. hundreds of page fetches) and
  avoids accidentally hammering pages that shouldn't be in a knowledge base
  (tag pages, paginated archives, etc.).
- **Why `ctx.waitUntil()` instead of awaiting the whole crawl in the request?**
  Cloudflare Workers have a request timeout. A 50-page crawl with Jina calls
  could take minutes — `waitUntil` lets the Worker return a `jobId`
  immediately while continuing work in the background, and the caller polls
  `/jobs/:id` for status. This is the same async-job pattern your "Durable
  Object" box uses for session state elsewhere in the architecture.
- **Why R2 for content but Neon for metadata, instead of just one store?**
  R2 is cheap, has no egress fees to Cloudflare Workers, and is built for
  large blobs. Postgres is bad at storing many large text blobs but great at
  filtering/joining/sorting structured metadata (e.g. "show me all docs from
  job X sorted by recency"). Splitting them is a standard object-storage +
  relational-index pattern.
- **Why `skipExisting` by default?** Re-crawling a site you've already
  ingested would otherwise create duplicate Jina calls (cost) and duplicate
  KB entries. The Neon `url` column has a `UNIQUE` constraint with
  `ON CONFLICT DO UPDATE`, so re-crawls update existing docs instead of
  duplicating them, and `docExistsByUrl` lets you skip re-scraping entirely
  when desired.

---

## Known limitations / next steps (good to mention proactively)

- No retry/backoff on `crawler.js` HTTP fetches (only `jina.js` has retry
  logic). If a site's robots.txt or sitemap.xml is flaky, the worker
  silently falls through to the next strategy — acceptable for now, but
  worth hardening later.
- `maxPages` is capped at 200 per job — fine for a demo/internship scope,
  but a real production crawler would need pagination across many smaller
  jobs for big sites.
- This layer doesn't yet talk to the AI Chunker / embeddings step in your
  diagram — that's intentionally out of scope here and is Layer 2.
