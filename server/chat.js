import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings, ChatOpenAI } from "@langchain/openai";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { PromptTemplate } from "@langchain/core/prompts";

/**
 * RAG pipeline (five stages, matching the architecture diagram in the slides):
 *   1. Document Loading  -> PDFLoader
 *   2. Splitting         -> RecursiveCharacterTextSplitter
 *   3. Storage           -> OpenAIEmbeddings + MemoryVectorStore
 *   4. Retrieval         -> vectorStore.asRetriever()
 *   5. Output            -> PromptTemplate + ChatOpenAI
 *
 * NOTE (course compromise): the vector store is rebuilt on every call, so the
 * same PDF gets re-embedded once per question. See Lesson 46 notes for the
 * production fix (build the store once, cache it outside of chat()).
 */
const chat = async (filePath = "./uploads/hbs-lean-startup.pdf", query) => {
  const apiKey = process.env.OPENAI_API_KEY;

  // step 1: document loading
  const loader = new PDFLoader(filePath);
  const data = await loader.load();

  // step 2: splitting
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 0,
  });
  const splitDocs = await textSplitter.splitDocuments(data);

  // step 3: embedding + storage (in-memory vector store)
  const embeddings = new OpenAIEmbeddings(apiKey ? { apiKey } : {});
  const vectorStore = await MemoryVectorStore.fromDocuments(
    splitDocs,
    embeddings
  );

  // step 5 (part 1): LLM + prompt template
  const model = new ChatOpenAI({
    model: "gpt-5",
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

  return { text: response.content };
};

export default chat;
