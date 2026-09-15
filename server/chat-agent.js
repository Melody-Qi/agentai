/**
 * Lesson 50 (prep) -- the agent decides when to search.
 *
 * Lesson 49's shape was two answers, both produced unconditionally:
 *
 *     ragAnswer  <- answerQuestion(vectorStore, q)   always
 *     mcpAnswer  <- chatMCP(q)                       always
 *
 * Both decisions were made in JavaScript, before the model saw the question.
 * There is even a comment in chat-mcp.js admitting it: "there is no 'should I
 * use the tool?' decision here -- unlike an LLM tool-calling loop, this call is
 * unconditional."
 *
 * This file moves those decisions into the model. It is handed the question, a
 * description of every tool it may use, and nothing else. Whether a search
 * happens at all, which tool runs, how many times, and what the search query
 * actually says are all outputs of the model's own reasoning.
 *
 * ---------------------------------------------------------------------------
 * Why this is cheap here, and expensive elsewhere
 *
 * A tool-calling loop normally costs you a manually maintained description of
 * every tool -- name, purpose, JSON Schema -- kept in sync with the code by
 * hand. MCP already publishes that: `tools/list` returns name, description and
 * JSON Schema, produced by the same file that implements the tool. So the agent
 * is handed its instructions by the tool server. The conversion in
 * chat-mcp.js's listAgentTools() is a rename of one field.
 *
 * That is the honest answer to "why MCP": not that it saves the loop (the loop
 * is 40 lines below), but that the tool's manual cannot drift from the tool.
 *
 * ---------------------------------------------------------------------------
 * What the loop actually buys, and what it costs
 *
 * Buys:
 *   - the question "does this need the web?" is answered by the thing that knows
 *     the question's content, not by a regex or a keyword list in Express
 *   - when it does search, the model writes the *search* query, which is not the
 *     user's query: "任何关于 Rust 的新闻?" becomes "Rust programming language
 *     latest release this week". A retrieval query and a human question are
 *     different strings and the model is good at the conversion
 *   - with two tools it becomes a choice, not a yes/no: the document or the web
 *   - it can go round again when the first answer is not enough
 *
 * Costs:
 *   - latency: one round is one model call; a search costs a second round plus
 *     the search itself
 *   - nondeterminism: the same question can search today and not tomorrow
 *   - quota: SerpApi's free plan is 250 searches/month, so "the model felt like
 *     it" is not an acceptable allocation policy. Hence MAX_WEB_SEARCHES below
 *   - a wrong decision is invisible: nothing crashes when the model answers from
 *     stale memory instead of searching, it just sounds confident
 * ---------------------------------------------------------------------------
 */
import { ChatOpenAI } from "@langchain/openai";
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { listAgentTools, callMcpTool } from "./chat-mcp.js";
import { retrieveChunks } from "./chat.js";

const MODEL_ID = () => process.env.OPENAI_MODEL ?? "gpt-6-astra";

// Guardrails. Every one of these exists because the model is not in charge of
// the bill, the quota, or the event loop.
const MAX_ROUNDS = Number(process.env.AGENT_MAX_ROUNDS ?? 3);
const MAX_WEB_SEARCHES = Number(process.env.AGENT_MAX_WEB_SEARCHES ?? 2);
const DOC_CHUNKS = Number(process.env.AGENT_DOC_CHUNKS ?? 4);

/**
 * Text out of a message's content, whichever shape the API returned.
 *
 * This is not defensive programming for its own sake -- the two model paths
 * under /chat really do return different types, and the difference is silent:
 *
 *   chat.completions  content = "17 × 23 = 391."          (a string)
 *   /v1/responses     content = [ {type:"text", text:"17 × 23 = 391.", ...} ]
 *
 * So `String(content)` on the Responses API gives "[object Object]" -- a
 * plausible-looking value that renders in the UI as `[object Object]`. Measured,
 * not guessed: see the spike in the Lesson 49 notes. Any code that consumes a
 * model response on this path has to flatten first.
 */
const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => typeof block === "string" || block?.type === "text")
    .map((block) => (typeof block === "string" ? block : block.text ?? ""))
    .join("")
    .trim();
};

/**
 * The document tool. Unlike the search tool this one is not in another process
 * -- the vector store is in memory in this one -- so it is described here rather
 * than fetched from an MCP server.
 *
 * Its description is doing the same job the search tool's description does, and
 * it is the load-bearing sentence in the whole design: given two tools, the
 * model picks between them by reading these two paragraphs. Write "search the
 * document" and it will search the document for questions about the weather.
 */
const DOC_TOOL = {
  type: "function",
  function: {
    name: "search_document",
    description:
      "Search the PDF the user uploaded. Use this for any question that could be answered by that specific document -- its content, its numbers, what it claims. Do not use it for general knowledge or current events.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for in the document.",
        },
      },
      required: ["query"],
    },
  },
};

/**
 * The routing policy, in prose.
 *
 * This prompt, together with the two tool descriptions, is where the "should I
 * search?" decision lives. It is not in the code below -- the code below only
 * carries out whatever the model decided. Changing the routing behaviour means
 * changing this text, which is why it is at the top of the file rather than
 * inlined.
 */
const SYSTEM_PROMPT = `You answer questions for a user who has uploaded a document. You have tools; use them when they help and answer directly when they do not.

- search_document: the user's uploaded PDF. Use it whenever the question is about that document.
- search_web: the public internet. Use it for anything the document cannot contain: news, current prices, releases, "today", "latest", or facts you are unsure of.
- If you already know the answer and it does not depend on the document or on current information, answer directly without calling anything.

Search only with a query you have not used before. When you have enough to answer, stop and answer: reply in the same language the user wrote in, be concise, and if the tools did not find it, say so plainly instead of guessing.`;

/**
 * Run one tool the model asked for, and turn MCP's result into something the
 * model can read.
 *
 * `search_document` is served from this process; everything else goes over MCP.
 * The two arrive here as one shape because that is what the model sees -- it
 * called a function and got text. Whether that function involved a child
 * process and JSON-RPC is not the model's business, which is the point of the
 * protocol.
 */
const runTool = async (call, { vectorStore, quota }) => {
  if (call.name === "search_document") {
    if (!vectorStore) {
      return { isError: true, text: "No document is attached to this conversation." };
    }
    const text = await retrieveChunks(
      vectorStore,
      call.args?.query ?? "",
      DOC_CHUNKS
    );
    // Finding nothing is not failing -- the search worked, the document just
    // does not discuss it. Reporting it as an error would tell the model to
    // apologize for a broken tool instead of telling the user the document is
    // silent on the point.
    return { isError: false, text };
  }

  if (call.name === "search_web") {
    // The quota check sits here, not in the prompt. A prompt is a request; this
    // is a limit. The model is told the budget is gone, which is information it
    // can act on -- answer with what it has -- rather than an error it cannot.
    if (quota.used >= MAX_WEB_SEARCHES) {
      return {
        isError: true,
        text: `Web search budget exhausted (${MAX_WEB_SEARCHES} searches per question). Answer with what you already have.`,
      };
    }
    quota.used += 1;
    return callMcpTool(call.name, call.args ?? {});
  }

  // A model that invents a tool name is not a crash, it is a wrong guess.
  return { isError: true, text: `No such tool: ${call.name}` };
};

/**
 * Answer a question, letting the model decide what to look up.
 *
 * Returns the answer plus the trace of what it decided -- which is the part
 * worth logging. In a tool-calling agent the interesting output is not the
 * answer, it is the sequence of choices that produced it.
 */
export const runAgent = async (question, { vectorStore = null, maxRounds = MAX_ROUNDS } = {}) => {
  // Connects on first use and publishes its tool list -- so the tools really are
  // described by the server, not by this file.
  const mcpTools = await listAgentTools();
  const tools = vectorStore ? [DOC_TOOL, ...mcpTools] : mcpTools;

  // useResponsesApi: gpt-6-astra rejects function tools on /v1/chat/completions
  // ("Function tools with reasoning_effort are not supported... use
  // /v1/responses"), so the tool-calling path has to be the Responses API. The
  // non-tool paths elsewhere in the project are unaffected.
  const model = new ChatOpenAI({
    model: MODEL_ID(),
    useResponsesApi: true,
  }).bindTools(tools);

  // The model that writes the final answer once the round budget is spent. No
  // tools bound, so its only possible output is text -- which is how the loop is
  // guaranteed to terminate on the next line after this one.
  const summarizer = new ChatOpenAI({
    model: MODEL_ID(),
    useResponsesApi: true,
  });

  const messages = [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(question)];
  const trace = [];
  const quota = { used: 0 };

  for (let round = 1; round <= maxRounds; round++) {
    const ai = await model.invoke(messages);
    // Pushed before anything else: an assistant message carrying tool_calls is
    // half a turn, and the API rejects the next request if its tool results are
    // missing. Keeping request and results adjacent is what makes the history
    // replayable -- and the history is replayed on every round.
    messages.push(ai);

    const calls = ai.tool_calls ?? [];

    // No tool wanted: the model answered. This is the branch that saves the
    // SerpApi quota, and it is indistinguishable in the code from a model that
    // answered because it had nothing better to do.
    if (calls.length === 0) {
      trace.push({ round, action: "answer" });
      return {
        text: textOf(ai.content),
        searched: trace.some((entry) => entry.action === "tool"),
        webSearches: quota.used,
        rounds: round,
        trace,
      };
    }

    for (const call of calls) {
      const result = await runTool(call, { vectorStore, quota });
      trace.push({
        round,
        action: "tool",
        tool: call.name,
        args: call.args,
        isError: result.isError,
        chars: result.text.length,
      });

      messages.push(
        new ToolMessage({
          content:
            result.text ||
            (result.isError ? "The tool failed and returned no message." : "No results."),
          tool_call_id: call.id,
        })
      );
    }
  }

  // Out of rounds while it still wanted to search. Answer with what is in hand
  // rather than looping -- the alternative is a request that never returns,
  // which is the same failure mode [DELTA 2] fixed one layer down.
  trace.push({ round: maxRounds + 1, action: "forced-answer" });
  const final = await summarizer.invoke(messages);

  return {
    text: textOf(final.content),
    searched: true,
    webSearches: quota.used,
    rounds: maxRounds,
    trace,
  };
};

export default runAgent;
