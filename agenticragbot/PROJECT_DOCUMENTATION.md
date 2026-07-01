# Agentic RAG KB Pipeline — Complete Project Documentation

**Repository:** [Pranav-0710/AgenticragChatbot](https://github.com/Pranav-0710/AgenticragChatbot)  
**Package:** `agenticragbot/`  
**Last updated:** 2026-07-02  
**Production Worker:** `https://kb-formation.contact-mergex.workers.dev`

---

## 1. What This Project Does

An **Agentic RAG Knowledge Base formation pipeline** for MergeX. It ingests website content, cleans markdown, chunks it into a graph-linked structure, builds cross-document memory maps, and stores everything for retrieval-augmented generation.

Two layers:

| Layer | Name | Status | Description |
|-------|------|--------|-------------|
| **1** | Ingestion | ✅ Implemented | Crawl/discover URLs → Jina scrape → save raw markdown to **R2** + metadata to **Neon** |
| **1.5** | Processing | ✅ Implemented | Clean → chunk → memory graph → save chunks to Neon (text in R2) + artifacts to R2 |

**Production runtime:** Cloudflare Worker (`src/index.js`)  
**Local dev:** `npm run worker:dev` (Worker) or `npm run start:express` (legacy Express for tests only)

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker (src/index.js)               │
│  POST /crawl  →  crawler + Jina  →  saveDocument (R2 + Neon)     │
│  POST /process/doc/:id  →  clean → chunk → memory → R2 + Neon      │
└────────────┬─────────────────────────────┬─────────────────────────┘
             │                             │
             ▼                             ▼
    ┌─────────────────┐          ┌─────────────────────┐
    │  R2: kb-storage │          │  Neon Postgres       │
    │  (all markdown) │          │  (metadata + graph)  │
    └─────────────────┘          └─────────────────────┘
```

### Storage split (R2-primary mode)

| Data | Location | Neon column / table |
|------|----------|---------------------|
| Raw markdown | R2 `kb/<domain>/<slug>/<docId>.md` | `kb_documents.r2_key` |
| Cleaned markdown | R2 `kb/cleaned/<docId>.clean.md` | `kb_documents.cleaned_r2_key` |
| Per-doc memory `.md` | R2 `kb/memory/<docId>.memory.md` | `kb_documents.memory_r2_key` |
| Chunk JSON (incl. text) | R2 `kb/memory/<docId>.chunks.json` | `kb_documents.chunks_json_r2_key` |
| Global memory index | R2 `kb/memory/memory-index.md` | (rendered from DB, cached in R2) |
| Chunk graph metadata | Neon `kb_chunks` | `text` empty when R2-primary; hydrated on read |
| Memory map JSON | Neon `kb_chunk_memory` | `chunk_graph` JSONB |
| Crawl jobs | Neon `kb_jobs` | status, counts, timestamps |

When `R2_PRIMARY=true` (default in `wrangler.toml`), `kb_documents.markdown_content` is cleared after successful R2 upload. Neon holds pointers only.

---

## 3. API Reference (Production Worker)

### Health & init

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Status, version, auth info (no auth required) |
| POST | `/init` | Create/alter Layer 1 + 1.5 schema |

### Layer 1 — Ingestion

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/crawl` | `{ "url": "...", "maxPages": 50 }` | Auto-crawl via sitemap/links |
| POST | `/crawl` | `{ "urls": ["https://...", ...] }` | Manual URL list |
| GET | `/jobs/:jobId` | — | Poll crawl job status |
| GET | `/kb/list` | `?jobId=&limit=` | List documents |
| GET | `/kb/doc/:docId` | — | Raw markdown from R2 |
| DELETE | `/kb/doc/:docId` | — | Delete doc + R2 objects + chunks |

**Crawl options:** `skipExisting` (default true), `processAfter` (chunk after scrape), `jinaDelayMs` (rate limit spacing).

Crawl runs in background via `ctx.waitUntil()` — returns `jobId` immediately with HTTP 202.

### Layer 1.5 — Processing

| Method | Path | Description |
|--------|------|-------------|
| POST | `/process/doc/:docId` | Full clean → chunk → memory → R2 pipeline |
| POST | `/process/batch` | `{ "docIds": ["...", ...] }` |
| POST | `/process/raw` | `{ "markdown": "...", "docId": "test" }` — no DB |
| GET | `/memory-index` | Cross-doc topic graph (JSON) |
| GET | `/memory/:docId` | Per-doc memory map (JSON) |
| GET | `/chunks?docId=` | List chunks (text hydrated from R2) |
| GET | `/chunks/:chunkId` | Single chunk |
| DELETE | `/chunks/:chunkId` | Cascade delete chunk |
| GET | `/inspect` | Docs + R2 migration status |
| GET | `/inspect/:docId` | Doc + stored vs live pipeline preview |

### R2 serving & migration

| Method | Path | Description |
|--------|------|-------------|
| GET | `/kb/cleaned/:docId` | Cleaned markdown from R2 |
| GET | `/kb/memory/:file` | `.memory.md`, `.chunks.json`, or `memory-index.md` |
| POST | `/sync/r2/:docId` | Backfill one doc Neon → R2 |
| POST | `/sync/r2/batch` | Batch backfill |
| POST | `/migrate/r2` | Full migration: init → sync → process → global index |

**Migration body:** `{ "clearNeon": true, "rescrapeMissing": true, "skipProcess": false }`  
`rescrapeMissing` re-fetches via Jina when Neon is empty and R2 object is missing (requires valid `JINA_API_KEY`).

### Auth

Production: `Authorization: Bearer <API_KEY>` on all routes except `/` and `/health`.  
Local dev (`wrangler dev --env dev`): `LOCAL_DEV=true` skips auth.

---

## 4. R2 Key Layout

```
kb/
├── mergex-in/
│   ├── about/
│   │   └── <docId>.md              # raw
│   └── index/
│       └── <docId>.md
├── cleaned/
│   └── <docId>.clean.md
└── memory/
    ├── <docId>.memory.md
    ├── <docId>.chunks.json
    └── memory-index.md
```

---

## 5. npm Scripts

| Script | Purpose |
|--------|---------|
| `npm start` / `npm run worker:dev` | Local Cloudflare Worker (`:8787`) |
| `npm run start:express` | Legacy Express (E2E tests only) |
| `npm run deploy` | Deploy Worker to Cloudflare production |
| `npm run r2:create` | Create `kb-storage` R2 bucket |
| `npm run migrate:r2` | Run full R2 migration via Worker API |
| `npm run sync:r2` | Batch sync raw markdown to R2 |
| `npm run test:fixtures` | Offline markdown edge-case tests (4 fixtures) |
| `npm run test:e2e` | Express HTTP + DB rollback tests (7 checks) |
| `npm run test:staging` | Full pipeline on Neon staging (blocks production URL) |
| `npm run staging:sync-schema` | Direct schema init (no HTTP) |
| `npm run test:pipeline` | Print clean/chunk output for sample doc |

---

## 6. Environment & Secrets

### Local (`.dev.vars` — never commit)

```bash
DATABASE_URL=postgresql://...@ep-xxx-pooler.../neondb?sslmode=require
JINA_API_KEY=jina_xxx          # required for /crawl and rescrape
API_KEY=your-bearer-token      # optional locally (LOCAL_DEV skips auth)
WORKER_URL=http://127.0.0.1:8787
```

Copy from `.dev.vars.example`.

### Cloudflare (production)

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put JINA_API_KEY
npx wrangler secret put API_KEY
npm run deploy
```

### wrangler.toml vars

| Var | Value | Purpose |
|-----|-------|---------|
| `ENVIRONMENT` | `production` | Runtime label |
| `R2_PRIMARY` | `true` | Markdown blobs in R2 only |
| `LOCAL_DEV` | `true` (env.dev only) | Skip auth in local Worker |

---

## 7. Database Schema

### Layer 1 — `kb_jobs`, `kb_documents`

- `kb_documents`: `id`, `url` (unique), `title`, `r2_key`, `cleaned_r2_key`, `memory_r2_key`, `chunks_json_r2_key`, `markdown_content` (empty when R2-primary), `char_count`, `word_count`, `scraped_at`

### Layer 1.5 — `kb_chunks`, `kb_chunk_memory`

- `kb_chunks`: graph-linked chunks (`prev_id`, `next_id`, `parent_id`, `children_ids`, `related_ids`); `text` empty in R2-primary mode
- `kb_chunk_memory`: per-doc memory map JSONB (`id` = docId)

Run `POST /init` or `npm run staging:sync-schema` to create/alter tables.

---

## 8. Test Results

| Test | Result |
|------|--------|
| `test:fixtures` | 4/4 PASS |
| `test:e2e` | 7/7 PASS |
| `test:pipeline` | PASS |
| Wrangler deploy dry-run | PASS (~410 KB bundle) |
| `test:staging` | Blocks if `DATABASE_URL` is production host (by design) |

---

## 9. File Structure (committed code)

```
agenticragbot/
├── src/
│   ├── index.js                 # Cloudflare Worker (production entry)
│   ├── handlers/
│   │   ├── processor.js         # Shared clean/chunk/save logic
│   │   └── crawl.js             # Layer 1 crawl orchestrator
│   ├── pipeline/                # clean.js, chunk.js, memory.js
│   ├── services/
│   │   ├── db.js                # Neon Layer 1 + R2 pointers
│   │   ├── storage.js           # R2 read/write
│   │   ├── crawler.js           # Sitemap + link crawl
│   │   └── jina.js              # Jina Reader API
│   └── chunk-db.js              # Neon Layer 1.5 + R2 chunk hydration
├── scripts/dev/                 # Tests, migrate, worker start
├── tests/fixtures/              # Offline markdown edge cases
├── server.js                    # LEGACY Express (test:e2e only)
├── wrangler.toml
├── package.json
├── CLOUDFLARE_MIGRATION.md      # Deploy & migrate runbook
└── PROJECT_DOCUMENTATION.md     # This file
```

---

## 10. Changes in This PR (Summary)

### New capabilities

- **Cloudflare Worker** as production API (`src/index.js`, Hono)
- **R2-primary storage** for all markdown and chunk text
- **Layer 1 crawl** (`POST /crawl`, `GET /jobs/:id`) with sitemap + Jina
- **CLI test buffer zone** (fixtures, e2e, staging with prod guardrail)
- **Migration tooling** (`POST /migrate/r2`, `npm run migrate:r2`)

### Bug fixes

- Re-enabled `express.json()` for POST body parsing
- Fixed `GET /memory-index` undefined variable
- Fixed `avgTokens` divide-by-zero
- Fixed `listDocsNeedingChunking` (`scraped_at` not `created_at`)
- Fixed `renderMemoryMd` camelCase/snake_case normalization
- Fixed Wrangler auth leak (`LOCAL_DEV`, `start-worker.js` clears `API_KEY`)

### Security / hygiene

- **Removed `.env` from git tracking** — secrets stay local
- `.gitignore` covers `.env`, `.dev.vars`, `kb/memory/`
- Bearer auth on production Worker when `API_KEY` secret is set

### Express demoted to legacy

- `npm start` runs Worker, not Express
- `server.js` retained only for `npm run test:e2e`

---

## 11. Deploy Checklist

```bash
cd agenticragbot
npm install
npx wrangler login
npm run r2:create                    # once per account
npx wrangler secret put DATABASE_URL
npx wrangler secret put JINA_API_KEY
npx wrangler secret put API_KEY      # recommended
npm run deploy
WORKER_URL=https://kb-formation.contact-mergex.workers.dev npm run migrate:r2
```

Verify:

```bash
curl https://kb-formation.contact-mergex.workers.dev/health
curl https://kb-formation.contact-mergex.workers.dev/inspect
```

---

## 12. Known Limitations

1. **Jina API key required** for `/crawl` and `rescrapeMissing` migration recovery.
2. **Re-processing** a doc may create duplicate chunk rows (old IDs not removed).
3. **Hyperdrive** not configured — Neon latency ~1–3s per query from Workers.
4. **Git push does not deploy** — only `wrangler deploy` updates production.
5. **Local miniflare R2 ≠ production R2** — run `migrate:r2` against deployed Worker URL after deploy.

---

## 13. What Is NOT in This Repo (intentionally)

| Excluded | Reason |
|----------|--------|
| `.env`, `.dev.vars` | Secrets |
| `kb/memory/` | Generated artifacts |
| `ignore/` | Local tooling |
| Session logs, PDFs, draft strategy docs | Not production code |

---

*For step-by-step deploy commands see [CLOUDFLARE_MIGRATION.md](./CLOUDFLARE_MIGRATION.md).*
