// Document list calls. Small file, deliberately: these two endpoints are the
// only ones App.js needs that neither PdfUploader nor ChatComponent already owns.
//
// DOMAIN is repeated here a fourth time (this file, PdfUploader, ChatComponent,
// dailyApi). Each copy is the same 40-character expression and each one is an
// opportunity for a deployment to update three of them. Pulling it into a shared
// `src/lib/apiBase.js` is the obvious next refactor -- it was left out of this
// change so the multi-document diff stays reviewable on its own terms.
import axios from "axios";

const DOMAIN = process.env.REACT_APP_API_DOMAIN || "http://localhost:5001";

const headers = (clientId) => ({ "x-client-id": clientId });

/** GET /documents -> [{ docId, originalName, pageCount, chunkCount, embedder }] */
export const fetchDocuments = async (clientId) => {
  const { data } = await axios.get(`${DOMAIN}/documents`, { headers: headers(clientId) });
  return data.documents ?? [];
};

/**
 * DELETE /documents/:docId -> nothing (204)
 *
 * The caller has already decided to drop it, so this does not ask whether the
 * document was selected: App removes it from both lists in the same update, and
 * a failure leaves both untouched rather than half-removed.
 */
export const deleteDocument = async (clientId, docId) => {
  await axios.delete(`${DOMAIN}/documents/${docId}`, { headers: headers(clientId) });
};
