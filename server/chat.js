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
