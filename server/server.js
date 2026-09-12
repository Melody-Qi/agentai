import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildIndex, answerQuestion } from "./chat.js";
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
 * ------------------------------------------------------------------------- */
app.use((req, res, next) => {
  const clientId = req.get("x-client-id");
  if (!clientId) {
    return res.status(400).json({ error: "missing x-client-id header" });
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

// GET /chat?docId=...&question=...  (header x-client-id)
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

  res.send({
    ragAnswer: text,
    mcpAnswer: "N/A", // placeholder, wired up in the next lesson
  });
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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
