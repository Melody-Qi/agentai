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

    // A tool result is a content *array*, not a string. [0].text is the text
    // block; a tool could equally return an image or a resource link.
    let searchResults = "";
    if (toolResult?.content && toolResult.content.length > 0) {
      searchResults = toolResult.content[0].text;
    }

    // [DELTA 3] Same model id resolution as chat.js -- one env var for the
    // whole project.
    const model = new ChatOpenAI({
      model: process.env.OPENAI_MODEL ?? "gpt-6-astra",
      ...(apiKey && { apiKey }),
    });

    const answerTemplate = `Summarize the search result.

Search Results:
{searchResults}

Helpful Answer:`;

    const prompt = PromptTemplate.fromTemplate(answerTemplate);
    const formattedPrompt = await prompt.format({
      // Empty content (a tool that returned nothing) would make the template
      // read like a blank search; say so explicitly instead.
      searchResults: searchResults || "No search results available",
    });

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
