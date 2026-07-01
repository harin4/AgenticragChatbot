# Agentic RAG Chatbot — Session 2026-07-02

## What got built
- Migrated production runtime to Cloudflare Worker (`src/index.js`) with R2-primary markdown storage (`kb-storage` bucket).
- Wired Layer 1 crawl (`POST /crawl`, `GET /jobs/:id`), chunk text offload to R2, CLI test harness (fixtures/e2e/staging), and migration tooling (`POST /migrate/r2`).
- Deployed Worker to `https://kb-formation.contact-mergex.workers.dev`; removed `.env` from git tracking.

## Decisions made and why
- **Decision:** R2-primary storage — Neon holds metadata + pointers, all markdown/chunk text in R2.
  - *Why:* Boss requirement; cheap blob storage at edge; matches architecture diagram.
  - *Alternative:* Dual-write Neon + R2 indefinitely — rejected (bloats Postgres).
- **Decision:** Express demoted to legacy (`start:express` only for E2E tests).
  - *Why:* Single production path reduces drift; Worker has full API parity.
- **Decision:** Staging test hard-blocks production Neon host in `run-staging-db-test.js`.
  - *Why:* Prevents accidental prod mutation during dev.

## Pivots (if any)
- None this session.

## Open questions / unresolved risk
- Valid `JINA_API_KEY` needed for production crawl and rescrape migration recovery.
- Re-processing same doc may orphan duplicate chunk rows.
- Production R2 population pending valid Jina key (`npm run migrate:r2` against deployed Worker).

## Next session starting point
- Set valid Jina secret → run `npm run migrate:r2` on production Worker URL.
- Optional: set `API_KEY` secret for production auth; dedupe chunk re-process behavior.
