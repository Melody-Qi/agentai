import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { PromptTemplate } from "@langchain/core/prompts";
import { chatSession, contentToText, createStickyEmbedder } from "./llm.js";

/**
 * RAG pipeline (five stages, matching the architecture diagram in the slides).
 *
 * The five stages split into two groups with very different cost profiles:
 *
 *   index time  (steps 1-3)  load -> split -> embed   expensive, grows with pages
 *   query time  (steps 4-5)  retrieve -> answer       cheap, one question
 *
 * Embedding dominates the cost: a 30-page PDF is ~60 chunks, i.e. 60 embedding
 * calls. The slides run all five steps inside chat(), so every question re-pays
 * those 60 calls -- that is where the ~15s per question came from.
 *
 *   buildIndex(filePath)       -> steps 1-3, runs ONCE per document
 *   answerQuestion(store, q)   -> steps 4-5, runs per question, embeds the
 *                                 question only (1 call)
 *
 * Neither step names a model any more. Which provider does the embedding and
 * which one writes the answer are both decided in llm.js, from whichever keys
 * are present -- see that file for why a dead key used to take this file down
 * with it.
 */

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 0;

/**
 * Steps 1-3: turn a PDF on disk into a searchable vector store. Call this once
 * per document and keep the result; it is the part that costs time, and formerly
 * the part that cost money.
 *
 * The embedder returned by createStickyEmbedder is not a client that was chosen
 * here -- it is an object that decides on the first batch and then stays decided.
 * The distinction is load-bearing: buildIndex knows the number of chunks but not
 * which provider can embed them, and only trying tells you. So the choice is
 * deferred to the first real call, and the outcome is reported back up.
 */
export const buildIndex = async (filePath) => {
  // step 1: document loading -> Document[] (one per page)
  const loader = new PDFLoader(filePath);
  const data = await loader.load();

  // step 2: splitting -> Document[] (one per chunk)
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });
  const splitDocs = await textSplitter.splitDocuments(data);

  // step 3: embedding + storage (in-memory vector store)
  const embedder = createStickyEmbedder();
  const vectorStore = await MemoryVectorStore.fromDocuments(splitDocs, embedder);

  // `embedder` here is the id, not the object -- the store keeps the object and
  // will use it for every later question, so all this needs to carry is *which*
  // one, for the API response and for the document record. Worth surfacing: the
  // local fallback is lexical rather than semantic, and a user whose PDF was
  // indexed that way should be able to see why the retrieval feels literal.
  return {
    vectorStore,
    pageCount: data.length,
    chunkCount: splitDocs.length,
    embedder: embedder.id,
  };
};

/**
 * Steps 4-5: retrieve the chunks closest to the question and let the model
 * answer from them. Takes an already-built store, so nothing is re-embedded
 * except the question itself.
 *
 * The store carries its own embedder, which is why retrieval works here without
 * this function knowing anything about embeddings at all -- and why the question
 * is always embedded in the same vector space as the document, even when the
 * document was indexed by a provider that has since failed.
 */
export const answerQuestion = async (vectorStore, query) => {
  // step 5 (part 1): LLM + prompt template. Which LLM is llm.js's decision; if
  // the first provider on the chain is dead this call transparently lands on the
  // next one, and the answer is what the caller sees either way.
  const session = chatSession({ label: "rag" });

  const template = `Use the following pieces of context to answer the question at the end. If you don't know the answer, just say that you don't know, don't try to make up an answer. Use three sentences maximum and keep the answer as concise as possible.

{context}
Question: {question}
Helpful Answer:`;

  const prompt = PromptTemplate.fromTemplate(template);
  const retriever = vectorStore.asRetriever();

  // step 4: retrieval
  const relevantDocs = await retriever.invoke(query);

  // step 5 (part 2): assemble the context, format the prompt, call the model
  const context = relevantDocs.map((doc) => doc.pageContent).join("\n\n");
  const formattedPrompt = await prompt.format({
    context,
    question: query,
  });

  const response = await session.invoke(formattedPrompt);

  // Flattened, not returned raw. The two wire protocols return a string and an
  // array of blocks respectively, and `String(array)` is "[object Object]" --
  // which does not throw and does render.
  return contentToText(response.content);
};

/**
 * The slides' version, kept so the two timings can be compared live: it rebuilds
 * steps 1-3 on every call, so the same PDF is re-embedded once per question.
 * server.js does NOT use this -- it builds the index on upload and caches it.
 */
const chat = async (filePath, query) => {
  const { vectorStore } = await buildIndex(filePath);
  return { text: await answerQuestion(vectorStore, query) };
};

/* ---------------------------------------------------------------------------
 * Asking several documents at once
 *
 * One document per vector store is the right unit of caching -- each index is
 * built once and reused. The question is what happens when the user has picked
 * three of them.
 *
 * The naive move is to search one store at a time and concatenate, which is
 * wrong in a way that is hard to notice: whichever document happens to be
 * written in the vocabulary of the question wins every slot, so "I asked my
 * three PDFs" quietly becomes "I asked the one that scored highest", and the
 * user never learns the other two were ignored.
 *
 * So retrieval is per document FIRST and merged SECOND. Every source gets to
 * nominate CHUNKS_PER_DOC candidates, and only then are the nominations ranked
 * against each other. A short document can lose the final ranking, but it can
 * never be absent from it on the grounds that a longer one scored higher.
 *
 * `similaritySearchWithScore` returns cosine SIMILARITY (see the `search.similarity`
 * field in @langchain/classic/vectorstores/memory), so it sorts descending --
 * the opposite of a distance metric.
 * ------------------------------------------------------------------------- */
const CHUNKS_PER_DOC = 4;
const CONTEXT_CHUNKS = 8;

// Word for word the template answerQuestion already used, so that asking one
// document through this path produces the same answers it always did.
const SINGLE_DOC_TEMPLATE = `Use the following pieces of context to answer the question at the end. If you don't know the answer, just say that you don't know, don't try to make up an answer. Use three sentences maximum and keep the answer as concise as possible.

{context}

Question: {question}
Helpful Answer:`;

const MULTI_DOC_TEMPLATE = `Use the following pieces of context to answer the question at the end. Each chunk is prefixed with the name of the file it came from, in square brackets. If the documents disagree with each other, say so rather than silently picking one. Name a source in plain prose when it helps -- "the logistics handbook says" -- but never reproduce the bracketed prefix itself. If you don't know the answer, just say that you don't know, don't try to make up an answer. Use three sentences maximum and keep the answer as concise as possible.

{context}

Question: {question}
Helpful Answer:`;

/**
 * Steps 4-5 across several cached indexes. Same cost profile as answerQuestion:
 * the question is embedded once, the documents are not touched.
 *
 * @param documents [{ originalName, vectorStore }, ...] already ownership-checked
 */
export const answerQuestionFromStores = async (documents, query) => {
  if (!documents?.length) {
    throw new Error("no documents selected");
  }

  // One failed store should not sink the rest: a document whose embedder has
  // since gone away still leaves the other two able to answer. Those that do
  // answer carry on; allSettled is what makes "one bad PDF" a partial answer
  // rather than an error page.
  const perDocument = await Promise.allSettled(
    documents.map(async ({ originalName, vectorStore }) => {
      const hits = await vectorStore.similaritySearchWithScore(query, CHUNKS_PER_DOC);
      return hits.map(([doc, similarity]) => ({
        doc,
        similarity,
        source: originalName,
      }));
    })
  );

  const ranked = perDocument
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, CONTEXT_CHUNKS);

  if (perDocument.every((result) => result.status === "rejected")) {
    throw new Error(perDocument[0].reason?.message ?? "every document failed to answer");
  }

  // The source label goes into the context, not just the code: it is how the
  // model can say "the 2023 report says X while the 2024 one says Y" instead of
  // blending the two into one confident, invented figure.
  //
  // Only labelled when there is something to disambiguate. With one document the
  // prefix is noise, and models have a habit of copying it into the answer -- an
  // answer that opens with "[report.pdf] Refunds take 30 days" reads like a bug.
  const labelSources = documents.length > 1;
  const context = ranked
    .map(({ doc, source }) =>
      labelSources ? `[${source}]\n${doc.pageContent}` : doc.pageContent
    )
    .join("\n\n");

  const session = chatSession({ label: "rag" });
  const prompt = PromptTemplate.fromTemplate(labelSources ? MULTI_DOC_TEMPLATE : SINGLE_DOC_TEMPLATE);
  const formattedPrompt = await prompt.format({ context, question: query });

  const response = await session.invoke(formattedPrompt);
  const answer = contentToText(response.content);

  // Belt and braces for the copying habit above: even told not to, a model will
  // sometimes open its answer with the label it was given. Stripping it from the
  // START only is safe -- a bracketed reference mid-answer is the model citing a
  // source, which is exactly what we asked for.
  const labelled = documents.map((doc) => doc.originalName).map(escapeRegExp);
  const prefix = new RegExp(`^\\s*\\[(?:${labelled.join("|")})\\]\\s*`);

  // trim() because models habitually answer "\n\nThe refund window is 30 days".
  // App.css sets white-space: pre-wrap on the bubble, so unlike most markup those
  // leading newlines do reach the user as dead space above the first line.
  return answer.replace(prefix, "").trim();
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export { CHUNKS_PER_DOC, CONTEXT_CHUNKS };

export default chat;

/**
 * Step 4 on its own, for callers that want the passages rather than a written
 * answer.
 *
 * answerQuestion() runs steps 4 and 5 together, which is right for the Lesson 47
 * UI -- one question typed by a human, one answer read by a human. It is wrong as
 * an agent tool, because the agent's caller is a model: hand it answerQuestion()
 * and every document lookup costs two model calls, the second one summarizing
 * the first. A tool should return evidence and let the caller phrase it.
 */
export const retrieveChunks = async (vectorStore, query, k = 4) => {
  const docs = await vectorStore.similaritySearch(query, k);
  return docs.map((doc) => doc.pageContent).join("\n\n---\n\n");
};
