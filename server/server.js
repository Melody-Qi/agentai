import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildIndex, answerQuestion } from "./chat.js";
import chatMCP, { closeMcpConnection } from "./chat-mcp.js";
import runAgent from "./chat-agent.js";
import {
  newDocId,
  saveDocument,
  getDocument,
  listDocuments,
  deleteDocument,
  toPublic,
} from "./store.js";

dotenv.config(); // load .env into process.env before anything reads it

const app = express();
app.use(cors()); // allow the React dev server (5173/3000) to call port 5001

const PORT = 5001;
const UPLOAD_ROOT = "uploads";

/* ---------------------------------------------------------------------------
 * 1. Identity — who is asking?
 *
 * There is no login system in this project, so the *client* declares who it is
 * through an `x-client-id` header (the browser generates one UUID once and
 * keeps it in localStorage). Three consequences, stated plainly:
 *
 *   + two honest clients can no longer see each other's documents
 *   + asking for someone else's docId returns 404, never their content
 *   - this is isolation, NOT authentication: anyone can forge the header.
 *     Real accounts (login -> signed JWT -> verify) are the upgrade path.
 *
 * The format is enforced, and that is not cosmetic: clientId is used to build a
 * filesystem path (uploads/<clientId>/). Without the check, `x-client-id: ..`
 * resolves to the project root and `a/../../b` to ./b, so an upload could be
 * planted in any directory the process can write to. Only letters, digits,
 * underscore and hyphen — no dots, no slashes — so path.join cannot escape.
 * ------------------------------------------------------------------------- */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

app.use((req, res, next) => {
  const clientId = req.get("x-client-id");
  if (!clientId) {
    return res.status(400).json({ error: "missing x-client-id header" });
  }
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    return res.status(400).json({
      error: "x-client-id must match /^[A-Za-z0-9_-]{8,64}$/",
    });
  }
  req.clientId = clientId;
  next();
});

/* ---------------------------------------------------------------------------
 * 2. Upload — one folder per client, one random file name per document
 *
 * Before: every upload was written to uploads/<the user's own file name>, so
 * two clients sending "report.pdf" overwrote each other, and the server kept a
 * single module-level `filePath` shared by all requests. Now the name on disk
 * is <docId>.pdf inside uploads/<clientId>/, so identical file names collide
 * with nothing and the original name is only ever metadata.
 * ------------------------------------------------------------------------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_ROOT, req.clientId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${req.docId}.pdf`),
});

const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

const assignDocId = (req, res, next) => {
  req.docId = newDocId();
  next();
};

// POST /upload  (multipart field "file", header x-client-id)
// -> 201 { docId, originalName, pageCount, chunkCount }
app.post("/upload", assignDocId, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "missing file field 'file'" });
  }

  // Steps 1-3 (load / split / embed) run exactly here, exactly once. This is
  // the slow half and it is paid on upload instead of on every question.
  const { vectorStore, pageCount, chunkCount } = await buildIndex(
    req.file.path
  );

  const doc = saveDocument(req.docId, {
    ownerId: req.clientId,
    filePath: req.file.path,
    originalName: req.file.originalname,
    size: req.file.size,
    pageCount,
    chunkCount,
    vectorStore,
  });

  res.status(201).json({
    docId: doc.docId,
    originalName: doc.originalName,
    pageCount: doc.pageCount,
    chunkCount: doc.chunkCount,
  });
});

/* ---------------------------------------------------------------------------
 * 3. Web search -- Lesson 49's MCP half
 *
 * The slides put both calls in one handler and return both answers:
 *
 *     const ragResp = await chat(filePath, req.query.question);
 *     const mcpResp = await chatMCP(req.query.question);
 *     res.send({ ragAnswer: ragResp.text, mcpAnswer: mcpResp.text });
 *
 * Ours is the same two answers, with three adaptations forced by Lessons 46-48:
 *
 *   a. The RAG call here is answerQuestion(doc.vectorStore, q), not
 *      chat(filePath, q). Lesson 46 split the pipeline so the index is built on
 *      upload; calling chat() would re-embed the PDF on every question.
 *   b. The document lookup and the ownership check stay in front of it, so this
 *      route is still scoped to the caller's own uploads.
 *   c. The web search is opt-out-able and never fatal. One call costs one unit
 *      of the SerpApi quota (free plan: 250 searches/month, i.e. ~8/day), so a
 *      question that does not need the web should not silently spend one, and a
 *      search that fails must not take the RAG answer down with it.
 *
 * Read at module scope, after dotenv.config() above -- an ordering that matters.
 * ------------------------------------------------------------------------- */
const WEB_SEARCH_ENABLED = Boolean(process.env.SERPAPI_KEY);

const runWebSearch = async (question, searchParam) => {
  // Opt-out via ?search=0. The front end does not send it yet; it exists so the
  // quota is a choice rather than a side effect.
  if (searchParam === "0" || searchParam === "false") {
    return "Web search skipped (?search=0).";
  }

  if (!WEB_SEARCH_ENABLED) {
    return "Web search unavailable: SERPAPI_KEY is not set in server/.env. See server/.env.example.";
  }

  try {
    const { text } = await chatMCP(question);
    return text;
  } catch (error) {
    // Degrade, do not fail: half an answer is worth more than a 500.
    console.error("MCP web search failed:", error.message);
    return `Web search failed: ${error.message}`;
  }
};

// GET /chat?docId=...&question=...&search=0  (header x-client-id)
app.get("/chat", async (req, res) => {
  const { docId, question } = req.query;
  if (!docId || !question) {
    return res.status(400).json({ error: "docId and question are required" });
  }

  const doc = getDocument(docId);
  // 404 rather than 403 on purpose. A 403 would answer "this document exists,
  // it just is not yours", which leaks the existence of other people's data.
  // Not-found and not-yours must look identical from the outside.
  if (!doc || doc.ownerId !== req.clientId) {
    return res.status(404).json({ error: "document not found" });
  }

  // Steps 4-5 over the cached store: only the question gets embedded.
  const text = await answerQuestion(doc.vectorStore, question);

  // Then the same question, answered from the open web by a tool in another
  // process. Sequential, not Promise.all: the two calls share one OpenAI rate
  // limit and the answers are read one after the other in the UI, so running
  // them in parallel would only make a 429 harder to attribute.
  const mcpAnswer = await runWebSearch(question, req.query.search);

  res.send({
    ragAnswer: text,
    mcpAnswer,
  });
});

// GET /chat-mcp?question=...  (header x-client-id)
// Lesson 49's MCP path without a document attached: the same call /chat makes,
// reachable on its own. Useful in Postman, and it is the endpoint a future
// "search-only" UI would use. 503 on a missing key, because that is a server
// configuration problem, not an answer.
app.get("/chat-mcp", async (req, res) => {
  const { question } = req.query;
  if (!question) {
    return res.status(400).json({ error: "question is required" });
  }
  if (!WEB_SEARCH_ENABLED) {
    return res.status(503).json({
      error: "web search disabled: SERPAPI_KEY is not set in server/.env",
    });
  }

  try {
    const { text } = await chatMCP(question);
    res.send({ mcpAnswer: text });
  } catch (error) {
    res.status(500).json({ error: `web search failed: ${error.message}` });
  }
});

/* ---------------------------------------------------------------------------
 * 3b. The agent -- Lesson 50's shape, reachable now for comparison
 *
 * Same question, same document, same two sources as /chat, with one difference:
 * neither call happens until the model asks for it. /chat spends one embedding
 * and one SerpApi search on every question; this route spends them only when the
 * model decides they are worth spending.
 *
 * Kept as a separate route rather than a flag on /chat so Lesson 49's contract
 * (two answers, both always present, rendered in the two UI blocks) stays exactly
 * as it was. The trade is visible by running the same question against both.
 *
 * The trace is returned because it, not the answer, is what you would debug:
 * `searched: false` on a question that obviously needed the web is the failure
 * mode this design introduces, and it looks like a perfectly good answer.
 * ------------------------------------------------------------------------- */
app.get("/chat-agent", async (req, res) => {
  const { docId, question } = req.query;
  if (!question) {
    return res.status(400).json({ error: "question is required" });
  }

  // docId is optional here -- an agent with no document is a web-search agent.
  let vectorStore = null;
  if (docId) {
    const doc = getDocument(docId);
    if (!doc || doc.ownerId !== req.clientId) {
      return res.status(404).json({ error: "document not found" });
    }
    vectorStore = doc.vectorStore;
  }

  try {
    const { text, ...meta } = await runAgent(question, { vectorStore });
    // `agentAnswer` mirrors the `ragAnswer` / `mcpAnswer` naming of /chat, so a
    // client can switch routes without changing how it reads the response. The
    // rest of the object is the trace -- see the comment above for why it ships.
    res.send({ agentAnswer: text, ...meta });
  } catch (error) {
    res.status(500).json({ error: `agent failed: ${error.message}` });
  }
});

// GET /documents -> only the caller's own documents
app.get("/documents", (req, res) => {
  res.json({ documents: listDocuments(req.clientId).map(toPublic) });
});

// DELETE /documents/:docId -> only if you own it
app.delete("/documents/:docId", (req, res) => {
  const doc = getDocument(req.params.docId);
  if (!doc || doc.ownerId !== req.clientId) {
    return res.status(404).json({ error: "document not found" });
  }
  fs.rmSync(doc.filePath, { force: true });
  deleteDocument(doc.docId);
  res.status(204).end();
});

/* ---------------------------------------------------------------------------
 * 4. Shutdown
 *
 * chat-mcp.js spawns a child process (`node mcp-server.js`). Strictly speaking
 * that child cleans itself up: when this process exits, the pipe to its stdin
 * closes, the stdio transport ends, and it goes away too (measured: a hard
 * process.exit() with no close() leaves zero extra node processes). What this
 * handler adds is order -- tell the client to close, wait for it, then exit,
 * instead of tearing the parent down while a tool call is in flight.
 * ------------------------------------------------------------------------- */
const shutdown = async (signal) => {
  console.log(`\n${signal} received, closing the MCP connection...`);
  await closeMcpConnection();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(
    WEB_SEARCH_ENABLED
      ? "MCP web search: enabled (search_web via serpapi-search)"
      : "MCP web search: DISABLED (set SERPAPI_KEY in server/.env to enable)"
  );
});
