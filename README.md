# agentai

Course project for the **Agent AI** module — an Express backend that answers questions
about an uploaded PDF through a RAG (Retrieval-Augmented Generation) pipeline.

## What it does

The five RAG stages are split by cost. Steps 1-3 are expensive and grow with the
number of pages, so they run **once per document, on upload**. Steps 4-5 are cheap
and run **per question**, embedding only the question itself.

```
POST /upload   (once per document)                 GET /chat   (once per question)
  multer                                            x-client-id + docId
     v                                                   v
  uploads/<clientId>/<docId>.pdf                    registry lookup + owner check
     v                                                   v
  PDFLoader                                         asRetriever() -> top-k chunks
     v                                                   v
  RecursiveCharacterTextSplitter                    PromptTemplate
     v                                                   v
  OpenAIEmbeddings -> MemoryVectorStore  ----+      ChatOpenAI (gpt-6-astra) -> answer
     |                                       |
     +--> cached in server/store.js  ---------+   (no re-embedding on question 2, 3, 4 ...)
```

## Endpoints

Every request must carry an `x-client-id` header (see **Identity** below).

| Method | Path | Body / query | Result |
| --- | --- | --- | --- |
| POST | `/upload` | multipart field `file` | `201` `{ docId, originalName, pageCount, chunkCount }` |
| GET | `/chat` | `?docId=...&question=...` | `{ ragAnswer, mcpAnswer }` |
| GET | `/documents` | — | the caller's own documents only |
| DELETE | `/documents/:docId` | — | `204`, only if the caller owns it |

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js (ESM), Express 5 |
| Upload | multer (disk storage, one folder per client) |
| RAG | LangChain v1 — `@langchain/openai`, `@langchain/textsplitters`, `@langchain/community` |
| Models | `gpt-6-astra` (override with `OPENAI_MODEL`) + `text-embedding-3-small` |
| Vector store | `MemoryVectorStore`, cached per document in `server/store.js` |
| Document registry | in-process `Map` (`server/store.js`) |

## Getting started

```bash
cd server
npm install
cp .env.example .env      # then put your own OPENAI_API_KEY in it
npm start                 # listens on http://localhost:5001
```

Upload a PDF and ask a question:

```bash
CLIENT=$(uuidgen)          # any stable id; the browser keeps one in localStorage
curl -H "x-client-id: $CLIENT" -F "file=@your.pdf" http://localhost:5001/upload
# -> {"docId":"...","pageCount":12,"chunkCount":24}

curl -H "x-client-id: $CLIENT" "http://localhost:5001/chat?docId=...&question=what+is+this+document+about"
```

## Identity and permissions

This project has no login system, so the client declares who it is with an
`x-client-id` header. Be precise about what that buys:

| | |
| --- | --- |
| It **does** stop | one client reading another client's document; guessing a `docId` returns `404` |
| It **does not** stop | anyone forging the header. It is isolation between honest clients, **not authentication** |

Two deliberate choices worth keeping:

- **Not-found and not-yours are both `404`.** Answering `403` would confirm that the
  `docId` exists and belongs to someone else, leaking the existence of other people's data.
- **The file name on disk is `<docId>.pdf`, inside `uploads/<clientId>/`.** The user's own
  file name is never used as a path, so two clients uploading `report.pdf` cannot collide.

## Notes and known limitations

- **Secrets** — `.env` is git-ignored; put a real key there, never in the source.
- **Proxy** — Node's `fetch` ignores the OS proxy settings. On a proxied network run
  `node --use-env-proxy server.js` with `HTTPS_PROXY` set.
- **In-memory registry** — `server/store.js` keeps documents in a `Map`. Restarting the
  server drops every index and forces a re-upload; a second process would not share it.
- **Upload is synchronous and slow** — step 3 (embedding) runs inside the `/upload`
  request, so a large PDF makes that request take seconds. The fix is a job queue plus a
  `status` field (`processing` / `ready` / `failed`) that `/chat` checks.
- **Sample document not included** — no PDF ships with this repository; upload your own.
- The React app in `src/` is the untouched Create React App scaffold; the work for this
  lesson lives in `server/`.

## Upgrade path

The in-memory registry is the teaching version of a table that would look like this in
production — the routes do not change, only the storage behind them:

| Field | Why |
| --- | --- |
| `doc_id` | the handle the client keeps; also the addressing unit for permissions |
| `owner_id` | the permission check, on every read |
| `storage_path` | to re-index or delete the file |
| `status` | upload is slow; `/chat` must not run against a half-built index |
| `page_count`, `chunk_count` | operations and debugging |
| `created_at` | retention / cleanup policy |

Swapping `MemoryVectorStore` for a persistent store (`Chroma`, `pgvector`) makes the
index survive restarts and lets several processes share it; for the embedding step
itself, LangChain also ships `CacheBackedEmbeddings` for chunk-level reuse.
