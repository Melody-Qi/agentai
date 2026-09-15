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
// Imported as a namespace because almost the whole module is in play here: the
// tick, the subscription registry, the inbox. One line at the top of this file
// instead of sixteen, and `daily.tick()` says where it came from.
import * as daily from "./daily.js";
// Read-only view of the model fallback chain, for the diagnostic route below.
import { describeProviders } from "./llm.js";
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
app.use(express.json()); // /daily takes a JSON body; every other route uses query

/* ---------------------------------------------------------------------------
 * 0. The scheduler's door, mounted above the identity wall
 *
 * Everything below this line assumes the caller is a browser holding a
 * localStorage client id. A cron job is not that: it has no browser, and it
 * cannot be given one, because x-client-id is a partition key rather than a
 * credential -- any caller can type any value.
 *
 * So the scheduler gets its own door with its own secret, and the door is placed
 * *before* the middleware that checks client ids. Order is the access control
 * here: Express matches in registration order, this route answers, and the
 * request never reaches the identity check below. Moving this line under the
 * `app.use` that follows is the one edit that breaks everything above.
 *
 * The secret is DAILY_TICK_TOKEN. Unset, the route is loopback-only, so an
 * unconfigured deployment is not an open one -- the same "degrade to something
 * safe rather than fail open" rule as a missing SERPAPI_KEY.
 * ------------------------------------------------------------------------- */
app.post("/daily/tick", handleDailyTick);

// Env-overridable because every host that is not a laptop sets PORT itself
// (App Runner, Cloud Run, Heroku), and because it lets a verification run start a
// second copy without evicting the one already on 5001.
const PORT = Number(process.env.PORT ?? 5001);
const UPLOAD_ROOT = process.env.UPLOAD_ROOT ?? "uploads";

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
// -> 201 { docId, originalName, pageCount, chunkCount, embedder }
app.post("/upload", assignDocId, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "missing file field 'file'" });
  }

  let index;
  try {
    // Steps 1-3 (load / split / embed) run exactly here, exactly once. This is
    // the slow half, and it used to be the half that required a working paid
    // key: 60 chunks is 60 embedding calls, and the first one that failed took
    // the whole request with it.
    index = await buildIndex(req.file.path);
  } catch (error) {
    // multer has already written the file to disk, and a docId that was never
    // registered can never be deleted through DELETE /documents/:docId -- so
    // without this line the failure is not just a 500, it is a 500 plus a file
    // on disk that nothing will ever collect. The 25MB limit is the worst case.
    fs.rmSync(req.file.path, { force: true });
    console.error(`Upload failed for ${req.file.originalname}: ${error.message}`);
    return res
      .status(502)
      .json({ error: `could not index the PDF: ${error.message}` });
  }

  const doc = saveDocument(req.docId, {
    ownerId: req.clientId,
    filePath: req.file.path,
    originalName: req.file.originalname,
    size: req.file.size,
    pageCount: index.pageCount,
    chunkCount: index.chunkCount,
    vectorStore: index.vectorStore,
    embedder: index.embedder,
  });

  res.status(201).json({
    docId: doc.docId,
    originalName: doc.originalName,
    pageCount: doc.pageCount,
    chunkCount: doc.chunkCount,
    // Which embedder indexed this document. "local" means the free lexical
    // fallback -- retrieval will match words rather than meaning -- and saying so
    // when the document appears is more useful than letting the user infer it
    // from the first disappointing answer.
    embedder: doc.embedder,
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
  let text;
  try {
    text = await answerQuestion(doc.vectorStore, question);
  } catch (error) {
    // 502, the same code /daily/:id/run uses for the same reason: the request was
    // fine, the thing that writes answers is not. Un-caught, this rejection
    // reached Express's default handler, which replies with an HTML page -- and a
    // JSON client cannot read that, so the UI showed axios's generic
    // "Request failed with status code 500" with the real cause nowhere.
    return res
      .status(502)
      .json({ error: `could not answer from the document: ${error.message}` });
  }

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

/* ---------------------------------------------------------------------------
 * 3c. The daily assistant -- the same agent, asked by a clock instead of a user
 *
 * /chat-agent answers a question somebody typed. These routes schedule that same
 * agent to answer a question nobody typed: the subscription supplies the topic,
 * the module supplies the clock, and the message lands in an inbox instead of in
 * a response body.
 *
 * Three of these are ordinary CRUD with the same ownership rule as documents
 * (404, never 403). The fourth -- POST /daily/:id/run -- is the one that matters
 * most in practice: without it, "does this work?" means waiting until tomorrow
 * morning, and a feature you cannot run on demand is a feature you cannot debug.
 * ------------------------------------------------------------------------- */

// POST /daily  { topic, hour, minute, timezone?, docId? }  -> 201 { subscription }
app.post("/daily", (req, res) => {
  const { topic, hour, minute, timezone, docId } = req.body ?? {};

  if (typeof topic !== "string" || topic.trim().length === 0 || topic.length > 200) {
    return res
      .status(400)
      .json({ error: "topic must be a string of 1-200 characters" });
  }

  // Number() first so "8" from a form field is accepted and 8.5 is not.
  const h = Number(hour);
  const m = Number(minute);
  if (!daily.isValidTime(h, m)) {
    return res.status(400).json({ error: "hour must be 0-23 and minute 0-59" });
  }

  const zone = timezone ?? daily.DEFAULT_TIMEZONE;
  if (!daily.isValidTimezone(zone)) {
    return res.status(400).json({ error: `unknown timezone: ${zone}` });
  }

  // A daily message costs a model call and possibly a search, every day, forever.
  // Unbounded subscriptions are an unbounded bill, so the cap is here rather than
  // in a prompt.
  if (daily.listSubscriptions(req.clientId).length >= daily.MAX_SUBSCRIPTIONS_PER_CLIENT) {
    return res.status(409).json({
      error: `at most ${daily.MAX_SUBSCRIPTIONS_PER_CLIENT} daily messages per client`,
    });
  }

  // Checked here for a 404 that matches every other route, and again inside
  // daily.js at generation time: this runs with the request's identity, that one
  // runs with nobody watching.
  if (docId) {
    const doc = getDocument(docId);
    if (!doc || doc.ownerId !== req.clientId) {
      return res.status(404).json({ error: "document not found" });
    }
  }

  const sub = daily.createSubscription({
    clientId: req.clientId,
    topic: topic.trim(),
    hour: h,
    minute: m,
    timezone: zone,
    docId: docId ?? null,
  });

  res.status(201).json({ subscription: daily.toPublicSubscription(sub) });
});

// GET /daily -> the caller's subscriptions, each with its next speaking time
app.get("/daily", (req, res) => {
  res.json({
    subscriptions: daily
      .listSubscriptions(req.clientId)
      .map((sub) => daily.toPublicSubscription(sub)),
  });
});

// DELETE /daily/:id  -> 204, only if you own it. Messages already sent stay:
// the inbox is a record of what the user was told, not a view over the schedule.
app.delete("/daily/:id", (req, res) => {
  if (!daily.deleteSubscription(req.params.id, req.clientId)) {
    return res.status(404).json({ error: "subscription not found" });
  }
  res.status(204).end();
});

// POST /daily/:id/run -> generate now, whatever the clock says
app.post("/daily/:id/run", async (req, res) => {
  const sub = daily.getSubscription(req.params.id, req.clientId);
  if (!sub) {
    return res.status(404).json({ error: "subscription not found" });
  }

  try {
    // Same code path as the timer: this consumes today, so running it by hand at
    // 07:00 means the 08:00 message has already been sent. That is the honest
    // behaviour -- "one message per day" is the invariant, and a manual run is
    // how you receive it early or retry it after a failure.
    const message = await daily.deliver(sub);
    res.status(201).json({ message: daily.toPublicMessage(message) });
  } catch (error) {
    // 502: the schedule is fine, the thing that writes the message is not.
    res.status(502).json({
      error: `could not generate the message: ${error.message}`,
      subscription: daily.toPublicSubscription(sub),
    });
  }
});

// GET /messages?limit=20 -> the inbox, newest first
app.get("/messages", (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  const messages = daily.listMessages(req.clientId, { limit });
  res.json({ messages: messages.map(daily.toPublicMessage) });
});

// POST /messages/:id/read -> 204
app.post("/messages/:id/read", (req, res) => {
  if (!daily.markMessageRead(req.params.id, req.clientId)) {
    return res.status(404).json({ error: "message not found" });
  }
  res.status(204).end();
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
 * 3d. Which model is actually answering?
 *
 * Every route above can silently land on a provider other than the one
 * configured first -- that is the whole feature -- and there is otherwise no way
 * to see it without reading the server's stdout. This answers it: the chain in
 * order, which providers have a key, which are in a cooldown and until when, and
 * what each one costs.
 *
 * Mounted *below* the identity middleware, unlike /daily/tick. It exposes no
 * user data, but it does expose which credentials this server holds and why
 * requests are failing, and the "only one door above the wall" rule in section 0
 * is worth more than the convenience of not sending a header.
 *
 * No key values, ever -- only whether one is present.
 * ------------------------------------------------------------------------- */
app.get("/llm/providers", (req, res) => {
  res.json(describeProviders());
});

/* ---------------------------------------------------------------------------
 * 4. The tick endpoint's handler
 *
 * A function declaration on purpose: the route near the top of this file refers
 * to it, and declarations hoist where a const arrow would still be in its
 * temporal dead zone. Same reason the body lives down here -- the route's
 * *position* is load-bearing (section 0), its body is not.
 * ------------------------------------------------------------------------- */
async function handleDailyTick(req, res) {
  const token = process.env.DAILY_TICK_TOKEN;
  const fromThisMachine = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    req.socket.remoteAddress ?? ""
  );

  if (token ? req.get("x-tick-token") !== token : !fromThisMachine) {
    return token
      ? res.status(401).json({ error: "invalid x-tick-token" })
      : res.status(503).json({
          error: "DAILY_TICK_TOKEN is not set; /daily/tick is loopback-only",
        });
  }

  try {
    // Idempotent, which is what makes it safe to call this from three places at
    // once -- the timer below, an external scheduler, and a human with curl.
    res.json(await daily.tick());
  } catch (error) {
    res.status(500).json({ error: `tick failed: ${error.message}` });
  }
}

/* ---------------------------------------------------------------------------
 * 4b. The last resort
 *
 * Express 5 forwards a rejected promise from a handler straight here, so this is
 * what any un-caught async route ends up returning. Without it, that is Express's
 * own HTML error page: readable by a human, unparseable by the React client,
 * which then shows axios's generic "Request failed with status code 500" and the
 * real cause nowhere.
 *
 * Every route that can realistically fail has its own try/catch above, because
 * each deserves a more specific status -- 502 for "the model is down", 503 for
 * "no key configured", 404 for "not yours". This is for the ones that do not, and
 * its whole job is to make sure the failure is still JSON.
 * ------------------------------------------------------------------------- */
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, error);
  res.status(500).json({ error: error.message ?? "internal error" });
});

/* ---------------------------------------------------------------------------
 * 5. Shutdown
 *
 * chat-mcp.js spawns a child process (`node mcp-server.js`). Strictly speaking
 * that child cleans itself up: when this process exits, the pipe to its stdin
 * closes, the stdio transport ends, and it goes away too (measured: a hard
 * process.exit() with no close() leaves zero extra node processes). What this
 * handler adds is order -- tell the client to close, wait for it, then exit,
 * instead of tearing the parent down while a tool call is in flight.
 *
 * The scheduler is stopped first for the same reason: it is the one thing in the
 * process that can be mid-write to a file, and being killed there is the only way
 * to lose a claim.
 * ------------------------------------------------------------------------- */
const shutdown = async (signal) => {
  console.log(`\n${signal} received, closing the MCP connection...`);
  daily.stopScheduler();
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

  // Print the fallback chain once, at boot, because the alternative is finding
  // out which provider answered by reading a stack trace. An empty chain is not a
  // soft warning -- every model-backed route will fail -- so it says so loudly
  // and names the two keys that cost nothing and need no credit card.
  const chain = describeProviders().chatOrder;
  console.log(
    chain.length
      ? `Model chain: ${chain.join(" -> ")} (first one that answers wins)`
      : "Model chain: EMPTY. No provider key is set, so /chat, /chat-agent and the\n" +
        "  daily assistant will all fail. Set ZHIPU_API_KEY (free, phone signup, no\n" +
        "  card: https://open.bigmodel.cn) or SILICONFLOW_API_KEY (https://siliconflow.cn)\n" +
        "  in server/.env and restart."
  );

  // The daily assistant. An in-process timer is the right default for a course
  // project and the wrong one for a host that scales to zero -- daily.js explains
  // why, and DAILY_SCHEDULER=off is the switch to flip when the scheduler moves
  // outside this process and starts calling POST /daily/tick instead.
  if (process.env.DAILY_SCHEDULER === "off") {
    console.log("Daily scheduler: off (DAILY_SCHEDULER=off)");
  } else {
    daily.startScheduler();
    console.log(
      `Daily scheduler: every ${process.env.DAILY_TICK_MS ?? 60000}ms, ` +
        `default timezone ${daily.DEFAULT_TIMEZONE} ` +
        `(DAILY_TICK_TOKEN ${process.env.DAILY_TICK_TOKEN ? "set" : "NOT set -- /daily/tick is loopback-only"})`
    );
  }
});
