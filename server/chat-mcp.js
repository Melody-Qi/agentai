/**
 * Lesson 49 -- MCP CLIENT (the "USB-C host" side).
 *
 * This is the file that replaces LangChain's tool-calling loop with a protocol.
 * Compare the two shapes:
 *
 *   Lesson 46/47 (no MCP):  the tool lived in this process, so LangChain had to
 *                           describe it to the model, decide when to call it,
 *                           parse the arguments, and loop.
 *   Lesson 49 (MCP):        the tool lives in another process. This file asks
 *                           the MCP server for what it can do, calls it by
 *                           name with JSON arguments, and gets text back. The
 *                           LLM never sees the tool; this file decides when to
 *                           call it. That is the whole trade: less magic, and
 *                           tools become reusable by any MCP host.
 *
 * Shape of a question:
 *
 *   chatMCP("who won yesterday's game")
 *     -> ensureConnected()            spawn node mcp-server.js, once, lazily
 *     -> client.callTool("search_web", { query, num })
 *     -> ChatOpenAI summarizes the returned text
 *     -> { text }
 *
 * ---------------------------------------------------------------------------
 * Three details below are not in the slides' snippet, and each one is a bug the
 * slides' version would eventually hit. They are marked [DELTA] so the notes
 * can point at them:
 *
 *   [DELTA 1] connect failure leaves an inconsistent state. The slides' version
 *             does recover -- chatMCP's catch closes and nulls client/transport
 *             -- but only because that catch happens to run afterwards. In
 *             between, `client` and `transport` are non-null while unconnected,
 *             which is a lie the fast path (`if (client && transport) return`)
 *             believes. Catching inside ensureConnected keeps the invariant
 *             "non-null means connected" owned by the file that defines it,
 *             instead of relying on every caller to restore it.
 *   [DELTA 2] timeout. callTool has no deadline. If the child process wedges,
 *             the awaiting Express handler never returns and the browser hangs
 *             forever with no error. A race against a timer turns that into a
 *             500 you can read.
 *   [DELTA 3] model id. The slides hard-code model: "gpt-5". chat.js reads
 *             process.env.OPENAI_MODEL (default gpt-6-astra), so the two halves
 *             of the project cannot drift apart.
 *   [DELTA 4] a model call for nothing. The slides summarize whatever comes
 *             back, including nothing: they substitute the literal string "No
 *             search results available" and ask the model to summarize *that*.
 *             One wasted call, and the user gets a sentence about the absence of
 *             data -- or worse, a tidy paraphrase of an error message presented
 *             as if it were a search result. Measured: all three outcomes
 *             (tool failed / found nothing / found something) cost one call.
 *             Now only the third does.
 * ---------------------------------------------------------------------------
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";

// ESM has no __dirname. Both lines are required, not stylistic: `join(__dirname,
// "mcp-server.js")` is how the child process is located, and without this the
// identifier is simply undefined and the spawn silently targets the wrong path.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The slides are self-contradictory here: the architecture line and the code
// heading both say `mcp_server.js` (underscore), while the client builds the
// path from `mcp-server.js` (hyphen). Only the client's spelling actually runs
// -- if the file on disk is named with an underscore, every call dies with
// "spawn node ... ENOENT". One name, defined once, right here.
const SERVER_PATH = join(__dirname, "mcp-server.js");

const TOOL_NAME = "search_web";

// The slides hard-code num: 5 at the call site while the tool schema advertises
// a default of 10. Env-overridable so the number of paid SerpApi results per
// question is a config change, not a code edit.
const SEARCH_RESULT_COUNT = Number(process.env.SERPAPI_NUM ?? 5);
const CALL_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS ?? 30000);

// --- [DELTA 2] -----------------------------------------------------------------
// Promise.race against a timer, with the timer always cleared so a successful
// call does not keep the event loop (and therefore the process) alive.
const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/* ---------------------------------------------------------------------------
 * Connection state.
 *
 * Four module-level variables, and each one answers a different question:
 *
 *   client            the live, connected client -- or null
 *   transport         the stdio pipe to the child process -- or null
 *   isConnecting      is a connect attempt in flight?
 *   connectionPromise the promise of that attempt, so a concurrent caller can
 *                     await it instead of spawning a second child process
 *
 * Spawning one child process per question would be correct but wasteful: ~100 ms
 * of node startup on every ask, plus a fresh SerpApi round trip's worth of setup.
 * So the connection is a lazily-created singleton, and the four variables above
 * are what "lazy singleton" costs in plain JavaScript.
 * ------------------------------------------------------------------------- */
let client = null;
let transport = null;
let isConnecting = false;
let connectionPromise = null;

/**
 * Connect on first use, then reuse. Lazy initialization: no connection is made
 * when the module is imported, so a server that never receives a question never
 * spawns a child process at all.
 */
const ensureConnected = async () => {
  // Fast path: already connected.
  if (client && transport) {
    return;
  }

  // Someone else is already connecting -- await their attempt rather than
  // starting a competing one. Without this, two questions asked at the same
  // time spawn two child processes and the second one overwrites the first,
  // leaking a process that nothing can ever close.
  if (isConnecting && connectionPromise) {
    await connectionPromise;
    return;
  }

  isConnecting = true;
  connectionPromise = (async () => {
    try {
      // 1. The client. name/version identify us to the server during the
      //    initialize handshake; they are how the server says "who is asking".
      client = new Client({
        name: "chat-client",
        version: "1.0.0",
      });

      // 2. The transport. This is the whole trick of a local MCP server: it is
      //    not a network service, it is a child process, and stdin/stdout
      //    carries the JSON-RPC. `command` + `args` are handed to spawn.
      //
      //    env: `...process.env` passes SERPAPI_KEY down to the child. The child
      //    also loads .env itself (see mcp-server.js) so the handoff is not the
      //    only thing keeping the key alive.
      transport = new StdioClientTransport({
        command: "node",
        args: [SERVER_PATH],
        env: {
          ...process.env, // inherit all environment variables from parent process
        },
      });

      // 3. Handshake. connect() performs the MCP initialize exchange and the
      //    tools/list request, so after this line client.callTool knows
      //    "search_web" exists.
      await client.connect(transport);
    } catch (error) {
      // [DELTA 1] A half-built client must not look like a healthy one.
      // Leave client/transport null so the next request tries to connect again
      // instead of short-circuiting into a permanent failure.
      client = null;
      transport = null;
      throw error;
    } finally {
      isConnecting = false;
      connectionPromise = null;
    }
  })();

  // Await the same promise the fast path above would have awaited. Reading the
  // variable (not the async IIFE) is safe even though the finally block nulls it
  // out: the expression is evaluated before this line suspends.
  await connectionPromise;
};

/**
 * Close the child process if one exists.
 *
 * Worth knowing before you write this off as belt-and-braces: the child does NOT
 * actually leak if you skip it. When the parent dies, the pipe to the child's
 * stdin reaches EOF, the SDK's StdioServerTransport closes, and the child exits
 * on its own -- verified by starting the transport and calling process.exit()
 * without close(), which left zero extra node processes behind.
 *
 * So why keep it? Because "the child will notice" is a side effect, not a
 * decision. close() makes shutdown immediate and ordered: the client sends the
 * protocol-level close, we wait for it, and only then does the process exit.
 * The alternative is that Ctrl-C tears the parent down mid-request and the child
 * finds out by having its input yanked out from under it.
 */
export const closeMcpConnection = async () => {
  if (!client) return;
  try {
    await client.close();
  } catch (error) {
    console.error("Error closing MCP client:", error.message);
  } finally {
    client = null;
    transport = null;
  }
};

// Re-exported so the tool name is defined in one place for both halves.
export { TOOL_NAME, SERVER_PATH };

/**
 * The Lesson 49 entry point: answer a question using a live web search.
 * server.js calls this next to answerQuestion(), so the two answers shown in the
 * UI come from genuinely different sources -- one from the uploaded PDF, one
 * from the open web.
 */
const chatMCP = async (query) => {
  const apiKey = process.env.OPENAI_API_KEY;

  try {
    // Ensure client is connected (reuse existing connection)
    await ensureConnected();

    // Always perform web search. Note there is no "should I use the tool?"
    // decision here -- unlike an LLM tool-calling loop, this call is
    // unconditional. Making the model choose would mean giving it the schema and
    // parsing tool_calls back out, which is precisely the LangChain machinery
    // MCP was introduced to replace.
    const toolResult = await withTimeout(
      client.callTool({
        name: TOOL_NAME,
        arguments: {
          query,
          num: SEARCH_RESULT_COUNT,
        },
      }),
      CALL_TIMEOUT_MS,
      `MCP tool "${TOOL_NAME}"`
    );

    // A tool result is a content *array*, not a string -- a tool could equally
    // return an image or a resource link. Take every text block there is, so a
    // tool that answers in two blocks still reads as one answer, and an empty
    // array (nothing found) naturally becomes "".
    const searchResults = (toolResult?.content ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    // --- [DELTA 4] Stop before the model is even constructed ----------------
    // Both branches below return the sentence the user should actually read, and
    // neither touches the network. Summarizing nothing costs a full call and
    // produces a sentence about the absence of data; summarizing a *failure*
    // costs the same call and then dresses the failure up as a search result.
    // The guards sit above `new ChatOpenAI` so that "this path spends nothing"
    // is visible in the shape of the function, not just in its behaviour.

    // The tool marks its own failures with isError, so a missing key or a
    // SerpApi error arrives as a flag instead of as prose we would have to
    // pattern-match. Passed through verbatim: the tool's message is more precise
    // than any paraphrase of it.
    if (toolResult?.isError) {
      return { text: searchResults || "The web search tool failed." };
    }

    // Nothing found. Say it in the caller's terms -- we still have the query,
    // the tool never needed it.
    if (!searchResults) {
      return { text: `No web results found for "${query}".` };
    }

    // [DELTA 3] Same model id resolution as chat.js -- one env var for the
    // whole project. Built here, after the guards, because this is the only
    // branch that needs it.
    const model = new ChatOpenAI({
      model: process.env.OPENAI_MODEL ?? "gpt-6-astra",
      ...(apiKey && { apiKey }),
    });

    const answerTemplate = `Summarize the search result.

Search Results:
{searchResults}

Helpful Answer:`;

    const prompt = PromptTemplate.fromTemplate(answerTemplate);
    const formattedPrompt = await prompt.format({ searchResults });

    const response = await model.invoke(formattedPrompt);

    return { text: response.content };
  } catch (error) {
    // If connection error, reset client to allow reconnection on next request
    // (the slides' comment -- and the reason the fast path can be trusted).
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore cleanup errors
      }
      client = null;
      transport = null;
    }

    throw error;
  }
};

export default chatMCP;

/* ---------------------------------------------------------------------------
 * Tool access, for the agent in chat-agent.js.
 *
 * chatMCP decides *for* the model: it always searches, then asks the model to
 * read what came back. Letting the model decide needs two things this file was
 * not exposing -- the list of tools, so the model can be told what exists, and a
 * way to call one by name with arguments the model chose.
 *
 * Both are thin on purpose. The connection stays owned here: still exactly one
 * child process, still one place that knows how to talk to it. chat-agent.js
 * holds only policy -- what to ask and when to stop -- and never touches the
 * transport.
 *
 * Note what is NOT here: any hand-written description of the search tool. The
 * schema comes off the wire from mcp-server.js. That is the part of MCP worth
 * paying for -- the tool's manual lives with the tool, so a second host (a
 * different app, a different model) gets the same accurate description for free
 * instead of a copy that drifts.
 * ------------------------------------------------------------------------- */

/**
 * Every tool the MCP server advertises, converted to the shape an OpenAI
 * function tool needs. MCP hands back JSON Schema, so this is a rename, not a
 * translation: `inputSchema` -> `parameters`.
 */
export const listAgentTools = async () => {
  await ensureConnected();
  const { tools } = await withTimeout(
    client.listTools(),
    CALL_TIMEOUT_MS,
    "MCP tools/list"
  );

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  }));
};

/**
 * Call one tool by name. Returns the two facts a caller can act on -- did it
 * fail, and what does it say -- instead of a raw MCP result the caller would
 * have to know how to unpack.
 */
export const callMcpTool = async (name, args = {}) => {
  await ensureConnected();
  const result = await withTimeout(
    client.callTool({ name, arguments: args }),
    CALL_TIMEOUT_MS,
    `MCP tool "${name}"`
  );

  return {
    isError: Boolean(result?.isError),
    text: (result?.content ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim(),
  };
};
