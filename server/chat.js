import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings, ChatOpenAI } from "@langchain/openai";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { PromptTemplate } from "@langchain/core/prompts";

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
 * those 60 calls — that is where the ~15s per question came from.
 *
 *   buildIndex(filePath)       -> steps 1-3, runs ONCE per document
 *   answerQuestion(store, q)   -> steps 4-5, runs per question, embeds the
 *                                 question only (1 call)
 */

const EMBEDDING_MODEL = "text-embedding-3-small";
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 0;

/**
 * Steps 1-3: turn a PDF on disk into a searchable vector store. Call this once
 * per document and keep the result; it is the part that costs money and time.
 */
export const buildIndex = async (filePath) => {
  const apiKey = process.env.OPENAI_API_KEY;

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
  const embeddings = new OpenAIEmbeddings({
    model: EMBEDDING_MODEL,
    ...(apiKey && { apiKey }),
  });
  const vectorStore = await MemoryVectorStore.fromDocuments(
    splitDocs,
    embeddings
  );

  return { vectorStore, pageCount: data.length, chunkCount: splitDocs.length };
};

/**
 * Steps 4-5: retrieve the chunks closest to the question and let the model
 * answer from them. Takes an already-built store, so nothing is re-embedded
 * except the question itself.
 */
export const answerQuestion = async (vectorStore, query) => {
  const apiKey = process.env.OPENAI_API_KEY;

  // step 5 (part 1): LLM + prompt template
  // The model is configurable through OPENAI_MODEL so it can be swapped without
  // touching code. NOTE: gpt-6-astra rejects a custom `temperature` and requires
  // the Responses API for tool calling; LangChain switches over when required.
  const model = new ChatOpenAI({
    model: process.env.OPENAI_MODEL ?? "gpt-6-astra",
    ...(apiKey && { apiKey }),
  });

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

  const response = await model.invoke(formattedPrompt);

  return response.content;
};

/**
 * The slides' version, kept so the two timings can be compared live: it rebuilds
 * steps 1-3 on every call, so the same PDF is re-embedded once per question.
 * server.js does NOT use this — it builds the index on upload and caches it.
 */
const chat = async (filePath, query) => {
  const { vectorStore } = await buildIndex(filePath);
  return { text: await answerQuestion(vectorStore, query) };
};

export default chat;
