# MergeX Agentic RAG — LangChain.js feature

Query/answer side only. The ingestion pipeline (root `server.js`, `src/pipeline`,
`src/services`) is untouched — same Neon chunks, same Qdrant collection.

```
features/langchain-agent/
  server/
    lib/          env loading, ChatGroq, CohereEmbeddings, QdrantVectorStore
    tools/        search_mergex_knowledge (the tool the LLM calls)
    agent/        pass1.js (agentic retrieval + confidence), pass2.js (related_ids expansion), index.js (orchestrator)
    routes/       POST /api/ask
    index.js      Express entry — port 3002
  client/         Vite + React UI — port 5173
```

## Run

Backend (from repo root, uses the root `.env`):
```bash
npm run agent:dev
```

Frontend:
```bash
cd features/langchain-agent/client
npm install
npm run dev
```

Open http://localhost:5173.

## How it works

1. **Pass 1 (agentic retrieval).** The LLM (ChatGroq, `llama-3.3-70b-versatile`) is
   bound to one tool, `search_mergex_knowledge`. It decides for itself whether and
   how many times to call it — the server never force-feeds chunks into the prompt.
   Each call embeds the query with `CohereEmbeddings` and searches the existing
   Qdrant collection via `QdrantVectorStore`, then hydrates full chunk rows
   (text, heading_path, `related_ids`) from Neon by `chunk_id`.
2. Once the model stops calling the tool, one structured-output call asks it to
   commit to an answer **and** self-report `confident: true/false`.
3. **Pass 2** only runs if `confident: false`. It walks the `related_ids` links
   already present on the chunks Pass 1 retrieved (built by the existing KB
   pipeline's cross-doc graph) — no new vector search — and re-answers with the
   widened context.
4. The API returns `answer`, `confident`, `pass2Triggered`, `citedChunkIds`,
   `sources` (with `via`: `search_tool` or `related_id (pass 2)`), and the
   `toolCalls` log, all of which the UI renders.

## Env

Reuses the root `.env` (`GROQ_API_KEY`, `COHERE_API_KEY`, `QDRANT_URL`,
`QDRANT_API_KEY`, `QDRANT_COLLECTION`, `DATABASE_URL`). Optional: `AGENT_PORT`
(default `3002`).
