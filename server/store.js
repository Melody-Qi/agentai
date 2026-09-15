import crypto from "node:crypto";

/**
 * Document registry — the "who owns what, and where is its index" table.
 *
 * One record per uploaded PDF. It answers four different questions:
 *
 *   who may read it     -> ownerId      (permission check on every request)
 *   where is the file   -> filePath     (re-index, delete)
 *   how do we answer    -> vectorStore  (the cached index: embedded ONCE)
 *   how good is it      -> embedder     (which embedder built that index)
 *
 * The last one is not bookkeeping. A vector store is only meaningful against the
 * embedder that filled it, and this project now has several: a real embedding
 * model on one of five providers, or the local lexical fallback when none of
 * them is reachable. "local" means retrieval matches words, not meaning, and
 * that is a difference the user should be able to see rather than infer from a
 * disappointingly literal answer.
 *
 * NOTE (course compromise): this is a Map in memory. Restart the process and
 * every document is gone; a second process would not see it either. The shape
 * of the record is what matters — replace the Map with a database table and
 * the routes in server.js barely change. See README "Upgrade path".
 */
const documents = new Map();

/** A docId is the handle the client keeps. Random, not guessable, not a path. */
export const newDocId = () => crypto.randomUUID();

export const saveDocument = (docId, fields) => {
  const record = { docId, ...fields, createdAt: new Date().toISOString() };
  documents.set(docId, record);
  return record;
};

export const getDocument = (docId) => documents.get(docId);

export const listDocuments = (ownerId) =>
  [...documents.values()].filter((doc) => doc.ownerId === ownerId);

export const deleteDocument = (docId) => documents.delete(docId);

/** Drop the heavy fields (vectorStore, filePath) before sending a record out. */
export const toPublic = ({
  docId,
  originalName,
  size,
  pageCount,
  chunkCount,
  embedder,
  createdAt,
}) => ({ docId, originalName, size, pageCount, chunkCount, embedder, createdAt });
