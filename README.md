# agentai

Course project for the **Agent AI** module — an Express backend that answers questions
about an uploaded PDF through a RAG (Retrieval-Augmented Generation) pipeline.

## What it does

```
POST /upload  ->  multer  ->  server/uploads/*.pdf
                                   |
GET /chat?question=...             v
                            PDFLoader
                                   v
                 RecursiveCharacterTextSplitter  (chunk 500 / overlap 0)
                                   v
                  OpenAIEmbeddings -> MemoryVectorStore
                                   v
                    asRetriever() -> top-k chunks
                                   v
             PromptTemplate + ChatOpenAI (gpt-5) -> answer
```

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js (ESM), Express 5 |
| Upload | multer (disk storage) |
| RAG | LangChain v1 — `@langchain/openai`, `@langchain/textsplitters`, `@langchain/community` |
| Models | `gpt-5` + `text-embedding-3-small` |
| Vector store | `MemoryVectorStore` (in-process, no persistence) |

## Getting started

```bash
cd server
npm install
cp .env.example .env      # then put your own OPENAI_API_KEY in it
npm start                 # listens on http://localhost:5001
```

Upload a PDF and ask a question:

```bash
curl -F "file=@your.pdf" http://localhost:5001/upload
curl "http://localhost:5001/chat?question=what is this document about"
```

## Notes and known limitations

- **Secrets** — `.env` is git-ignored; put a real key there, never in the source.
- **Proxy** — Node's `fetch` ignores the OS proxy settings. On a proxied network run
  `node --use-env-proxy server.js` with `HTTPS_PROXY` set.
- **Single-user state** — `filePath` in `server/server.js` is a module-level variable shared
  by every request, so two concurrent uploads overwrite each other. The fix is to return a
  `fileId` on upload and scope the chat call to it.
- **Re-embedding on every question** — `chat()` rebuilds the vector store per call, so the
  same PDF is embedded again for each question. Building it once and caching it outside
  `chat()` takes a typical question from roughly 15 s to 2 s.
- **Sample document not included** — the fallback path in `server/chat.js` points at a
  course PDF that is not part of this repository; upload your own file first.
- **No auth, no persistence, single process** — a teaching implementation, not a service.
- The React app in `src/` is the untouched Create React App scaffold; the work for this
  lesson lives in `server/`.
