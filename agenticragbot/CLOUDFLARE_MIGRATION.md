# Cloudflare Migration — R2 Markdown Storage

**Production runtime:** Cloudflare Worker (`src/index.js`)  
**Markdown storage:** Cloudflare R2 (`KB_BUCKET` → `kb-storage`)  
**Neon:** Metadata, chunk graph, memory JSON — **not** full markdown blobs (R2-primary mode)

---

## Architecture

```
                    ┌─────────────────────┐
  POST /crawl       │  Cloudflare Worker  │
  (Phase 2)    ───► │  src/index.js       │
                    └──────────┬──────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
   ┌───────────┐        ┌────────────┐        ┌────────────┐
   │ R2 Bucket │        │ Neon DB    │        │ (future)   │
   │ kb-storage│        │ metadata + │        │ Hyperdrive │
   └───────────┘        │ chunks     │        └────────────┘
                        └────────────┘

R2 key layout:
  kb/<domain>/<slug>/<docId>.md     raw markdown
  kb/cleaned/<docId>.clean.md       cleaned markdown
  kb/memory/<docId>.memory.md       per-doc memory map
  kb/memory/<docId>.chunks.json     chunk JSON export
  kb/memory/memory-index.md         global cross-doc index
```

Neon `kb_documents` stores **pointers** (`r2_key`, `cleaned_r2_key`, `memory_r2_key`, `chunks_json_r2_key`).  
When `R2_PRIMARY=true` (default in `wrangler.toml`), `markdown_content` in Neon is cleared after R2 upload.

---

## One-time setup

```bash
cd agenticragbot

# 1. Cloudflare login
npx wrangler login

# 2. Create R2 bucket (once per account)
npm run r2:create
# or: npx wrangler r2 bucket create kb-storage

# 3. Local secrets
cp .dev.vars.example .dev.vars
# Edit: DATABASE_URL, optional JINA_API_KEY

# 4. Production secrets (before deploy)
npx wrangler secret put DATABASE_URL
npx wrangler secret put API_KEY
```

---

## Migrate existing Neon markdown → R2

### Option A — CLI (recommended)

```bash
# Terminal 1: start Worker with R2 binding
npm run worker:dev

# Terminal 2: full migration (sync + process + global index)
npm run migrate:r2

# Sync only (no re-chunking):
npm run migrate:r2 -- --sync-only

# Sync all docs via batch endpoint:
npm run sync:r2
```

### Option B — HTTP API

```bash
# Schema + full migration
curl -X POST http://127.0.0.1:8787/migrate/r2 \
  -H "Content-Type: application/json" \
  -d '{"clearNeon": true}'

# Batch sync raw markdown only
curl -X POST http://127.0.0.1:8787/sync/r2/batch \
  -H "Content-Type: application/json" \
  -d '{"clearNeon": true}'

# Check migration status
curl http://127.0.0.1:8787/inspect
```

### Option C — Deployed Worker

```bash
export WORKER_URL=https://kb-formation.<subdomain>.workers.dev
export API_KEY=your-secret
npm run migrate:r2
```

---

## Deploy to production

```bash
# Deploy production Worker (NOT --env dev)
npm run deploy

# Verify
curl https://kb-formation.<subdomain>.workers.dev/health
curl -H "Authorization: Bearer $API_KEY" \
  -X POST https://kb-formation.<subdomain>.workers.dev/migrate/r2 \
  -H "Content-Type: application/json" \
  -d '{"clearNeon": true}'
```

**Important:** `wrangler deploy` uses top-level `[vars]` → `ENVIRONMENT=production`, auth enabled when `API_KEY` secret is set.  
Local dev uses `npm run worker:dev` → `--env dev` → `LOCAL_DEV=true` (auth skipped).

---

## Serving markdown from R2

| Route | Content |
|-------|---------|
| `GET /kb/doc/:docId` | Raw markdown |
| `GET /kb/cleaned/:docId` | Cleaned markdown |
| `GET /kb/memory/:docId.memory.md` | Per-doc memory |
| `GET /kb/memory/:docId.chunks.json` | Chunk JSON |
| `GET /kb/memory/memory-index.md` | Global topic index |

All responses include `X-R2-Key` header when served from R2.

---

## Express (`server.js`) — legacy local dev

Express remains for local CLI tests (`npm run test:e2e`). It does **not** write to R2.  
**Production path is the Worker only.**

---

## Environment variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `DATABASE_URL` | wrangler secret / `.dev.vars` | Neon connection |
| `API_KEY` | wrangler secret | Bearer auth (production) |
| `R2_PRIMARY` | `wrangler.toml` [vars] | `true` = markdown in R2 only |
| `LOCAL_DEV` | `[env.dev]` only | Skip auth in local Worker |
| `WORKER_URL` | shell env | Target for `migrate:r2` / `sync:r2` scripts |
| `JINA_API_KEY` | secret | Layer 1 crawl (Phase 2) |

---

## Phase 2 (optional future)

- Hyperdrive for lower Neon latency
- Chunk embedding vectors in pgvector

## Layer 1 crawl (implemented)

`POST /crawl` accepts auto-crawl (`url` + `maxPages`) or manual URL list (`urls` array).
Jobs run in background via `waitUntil` — poll `GET /jobs/:jobId`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `KB_BUCKET R2 binding not configured` | Run `npm run r2:create`, ensure `wrangler.toml` has `[[r2_buckets]]` |
| `R2 object missing for r2_key=...` | Re-run `POST /sync/r2/:docId` or `npm run migrate:r2` |
| Auth 401 on migrate script | Set `API_KEY` env or use `worker:dev` (LOCAL_DEV) |
| `test:staging` blocked | Point `.env` at staging branch, not production |
