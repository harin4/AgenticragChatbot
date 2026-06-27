---
name: kb-pipeline
description: >
  Skill for building and extending the Agentic RAG Knowledge Base Pipeline (Layer 1 → 1.5).
  Use whenever working on: markdown cleaning, topic-tree construction, graph-interconnected
  chunking, memory.md file generation, cross-document related_ids wiring, Neon DB schema
  for kb_chunks / kb_chunk_memory, or the Express Layer 1.5 server.
version: 1.0.0
project: Agentic RAG Chatbot — Mergex Internship
layer: "1.5 — KB Clean + Chunk + Memory"
stack: "Node.js ESM · Express.js · Neon Postgres (@neondatabase/serverless) · Jina AI Reader"
---

# KB Pipeline Skill

## What this project does

Layer 1 (Cloudflare Worker) scrapes websites via Jina AI → saves raw markdown to Neon `kb_documents`.

Layer 1.5 (this Express server) takes that raw markdown and runs it through three stages before it goes to Layer 2 (embeddings + Qdrant):

```
kb_documents (Neon)
    │
    ▼  POST /process/doc/:docId
┌─────────────────────────────────────────────────┐
│  PHASE A — clean.js                             │
│    Parse YAML front matter                      │
│    Triage images: drop (no alt) / keep (has alt)│
│    Strip boilerplate (nav, cookies, footer)     │
│    Promote **Bold** fake-headings → ### real    │
│    Re-flow hard-wrapped lines → full paragraphs │
│    Build topic tree: H1 > H2 > H3 hierarchy    │
│    Deduplicate repeated sections                │
└───────────────┬─────────────────────────────────┘
                │  topic tree + front matter
                ▼
┌─────────────────────────────────────────────────┐
│  PHASE B — chunk.js                             │
│    Flatten topic tree → chunks (≤512 tokens)   │
│    Wire prev_id ↔ next_id (reading order)      │
│    Wire parent_id ↔ children_ids (hierarchy)   │
│    Wire related_ids (cross-doc, via memoryIndex)│
│    Tag graph_role: root | branch | leaf         │
└───────────────┬─────────────────────────────────┘
                │  flat chunk array
                ▼
┌─────────────────────────────────────────────────┐
│  MEMORY LAYER — memory.js                       │
│    Load ALL prior docs from kb_chunk_memory     │
│    Build cross-doc memoryIndex (topic → chunkId)│
│    Save memory map → Neon kb_chunk_memory       │
│    Write <docId>.memory.md → kb/memory/         │
│    Write <docId>.chunks.json → kb/memory/       │
│    Back-fill related_ids in prior chunks        │
│    Regenerate global memory-index.md            │
└───────────────┬─────────────────────────────────┘
                │
    kb_chunks (Neon) + kb/memory/*.md files
                │
                ▼
         Layer 2: Embeddings + Qdrant
```

---

## File map

```
server.js                   ← Express entry point (Layer 1.5)
kb-pipeline/
  clean.js                  ← Phase A: markdown → topic tree
  chunk.js                  ← Phase B: topic tree → graph chunks
  index.js                  ← cleanAndChunkMarkdown() — unified export
  memory.js                 ← Memory layer: build index, write .md files
src/
  db.js                     ← Neon: kb_documents (Layer 1 tables)
  chunk-db.js               ← Neon: kb_chunks + kb_chunk_memory (Layer 1.5)
  crawler.js                ← Sitemap + recursive crawl (Layer 1)
  jina.js                   ← Jina AI Reader wrapper (Layer 1)
kb/
  memory/
    <docId>.memory.md       ← Per-doc topic/chunk map (human-readable)
    <docId>.chunks.json     ← Per-doc chunk array (machine-readable)
    memory-index.md         ← Global cross-doc topic index
scripts/
  init-db.js                ← One-time Neon schema setup
  test-pipeline.js          ← Run pipeline on sample markdown
inspect-kb.js               ← Terminal inspector for docs/chunks
```

---

## Neon DB schema (Layer 1.5 tables)

### kb_chunks
```sql
id           TEXT PRIMARY KEY        -- "<docId>#<slug>-<index>"
doc_id       TEXT NOT NULL           -- parent document
index        INTEGER                 -- position within doc
source_url   TEXT                    -- original page URL
heading_path JSONB                   -- ["H1 title", "H2 title", "H3 title"]
slug         TEXT                    -- url-safe heading slug
text         TEXT NOT NULL           -- clean chunk content (≤512 tokens)
token_count  INTEGER                 -- estimated token count (chars/4)
has_images   BOOLEAN                 -- true if chunk references images
graph_role   TEXT                    -- 'root' | 'branch' | 'leaf'
prev_id      TEXT                    -- previous chunk in reading order
next_id      TEXT                    -- next chunk in reading order
parent_id    TEXT                    -- parent topic chunk (null for root)
children_ids JSONB                   -- array of child chunk ids
related_ids  JSONB                   -- cross-doc chunks on same topic ← KEY FIELD
images       JSONB                   -- [{alt, shortUrl}] for kept images
embedding    vector(384)             -- filled by Layer 2 (null here)
```

### kb_chunk_memory
```sql
id           TEXT PRIMARY KEY        -- docId
chunk_graph  JSONB                   -- full memory map (topics + connections)
updated_at   TIMESTAMPTZ
```

---

## Graph edge types (how "interconnected chunking" works)

This is graph chunking stored IN the vector DB (Qdrant), NOT a separate graph DB.

| Edge field    | What it connects | Direction |
|---------------|-----------------|-----------|
| `prev_id`     | Same doc, previous chunk in reading order | ← |
| `next_id`     | Same doc, next chunk in reading order | → |
| `parent_id`   | The H1/H2 topic this chunk belongs to | ↑ |
| `children_ids`| H2/H3 subtopics under this chunk | ↓ |
| `related_ids` | **OTHER docs** with same topic title | ↔ cross-doc |

`related_ids` is the graph edge your mentor described. After similarity search in Qdrant returns chunk X, the agent walks `related_ids` to pull in chunk Y from another document — without a graph DB query. The edges live flat in the vector payload.

---

## The memory.md system

Each processed doc gets two files in `kb/memory/`:

**`<docId>.memory.md`** — human-readable topic map:
- Doc metadata (URL, title, timestamp)
- Per-chunk table: slug, role, token count, graph connections, content preview
- Cross-doc links (related_ids) listed with the target chunk ID

**`memory-index.md`** — global cross-document index:
- Every topic title in the KB and which docs/chunks cover it
- Shared topics (🔗) highlighted — these are the active graph edges
- Used by humans to audit what the KB knows and where knowledge overlaps

The JSON equivalent lives in Neon `kb_chunk_memory` and is what the chunker actually reads.

---

## How to run the pipeline

```bash
# First time only — create Neon tables
node scripts/init-db.js

# Start the server
node server.js

# Process a single doc (fetch docId from kb_documents table)
curl -X POST http://localhost:3001/process/doc/<docId>

# Process multiple docs (serial — each sees prior docs' memory)
curl -X POST http://localhost:3001/process/batch \
  -H "Content-Type: application/json" \
  -d '{"docIds": ["<id1>", "<id2>", "<id3>"]}'

# Check cross-doc graph
curl http://localhost:3001/memory-index

# Read a doc's memory map (JSON)
curl http://localhost:3001/memory/<docId>

# Open memory files in VS Code
code kb/memory/
```

---

## Key design decisions (defend these to your mentor)

**Why Express.js (not Cloudflare Worker) for Layer 1.5?**
The cleaning and chunking involves: file I/O (writing `.md` files), `fs` module, serial processing with state (memory index grows as docs are processed), and no need for edge-distribution. Workers can't do `fs` writes or serial stateful batches. Express on Node.js is the right tool here. Workers handle the user-facing chatbot (Layer 2+).

**Why serial processing in `/process/batch`?**
Each doc's chunks are enriched with `related_ids` pointing to prior docs. If docs were processed in parallel, they'd all see the same empty memory index. Serial = each doc inherits the previous doc's topic knowledge.

**Why write `.md` files AND store JSON in Neon?**
- Neon `kb_chunk_memory` is the machine-readable source of truth — queried by code
- `kb/memory/*.memory.md` is the human-readable audit trail — reviewed in VS Code/GitHub
- `memory-index.md` is the "map of the KB's knowledge" — what your mentor described as the memory file the chunker refers to

**Why `related_ids` instead of a graph DB?**
Vector DBs (Qdrant) already store arbitrary payload fields alongside embeddings. Storing cross-doc edges as a `related_ids` array in the payload means: zero extra infrastructure, agent can traverse in O(1) per hop, and the graph grows incrementally as docs are processed.

**Why is `embedding` NULL in kb_chunks?**
Layer 1.5 produces structure. Layer 2 (a separate script/service) reads the chunks from kb_chunks, calls the embedding model (BGE/jina-embeddings-v3), and writes vectors to both `kb_chunks.embedding` and Qdrant. Clean separation of concerns.

---

## Common errors and fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `EADDRINUSE :::3001` | Another process is using port 3001 | `netstat -ano \| findstr :3001` then `taskkill /PID <pid> /F` |
| `related_ids: []` for all chunks | Processing docs in isolation (no prior memory loaded) | Use `/process/batch` with all docIds together, or re-process all docs after first KB build |
| `chunk_graph is null` | Doc not yet processed through Layer 1.5 | Run `POST /process/doc/<docId>` first |
| Tiny chunks (<80 tokens) | Short section in source page | Expected — chunk.js merges these into the previous sibling |
| `vector(384)` column error | pgvector extension not enabled in Neon | Run `CREATE EXTENSION IF NOT EXISTS vector;` in Neon SQL editor |

---

## What Layer 2 (embeddings) will consume

Layer 2 reads from `kb_chunks` and expects:
- `text` — the clean chunk content to embed
- `heading_path` — for Qdrant payload metadata
- `graph_role` / `prev_id` / `next_id` / `parent_id` / `children_ids` / `related_ids` — stored in Qdrant payload so the agent can traverse the graph after similarity search

The agent retrieves the top-K similar chunks from Qdrant, then walks the graph edges (prev → next → parent → children → related) to expand context — this is the "agentic" part of the RAG architecture.
