/**
 * Lesson 49 -- MCP SERVER (the "USB-C device" side).
 *
 * This file is NOT an Express server and it does NOT listen on a port. It is a
 * child process that talks JSON-RPC 2.0 over stdin/stdout, spawned by
 * chat-mcp.js with `node mcp-server.js`. Its whole job is to expose one tool:
 *
 *     search_web(query, num) -> text
 *
 * The point of MCP is that this file knows nothing about the LLM, and the LLM
 * knows nothing about SerpAPI. The model is handed the tool's *name*,
 * *description* and *JSON schema*; the transport is somebody else's problem.
 *
 * ---------------------------------------------------------------------------
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. NEVER console.log(). With StdioServerTransport, stdout IS the protocol
 *    channel. One stray console.log corrupts the JSON-RPC stream and the client
 *    dies with a parse error that looks nothing like the real cause. Hence
 *    console.error() everywhere -- stderr is free for humans.
 *
 * 2. The tool handler must never throw. A thrown error tears down the transport
 *    and the caller sees "connection closed" instead of "your API key is
 *    missing". Returning the error as ordinary tool *content* keeps the channel
 *    alive and lets the model read the failure and react to it.
 * ---------------------------------------------------------------------------
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getJson } from "serpapi";
import dotenv from "dotenv";
import { pathToFileURL } from "node:url";

/**
 * The slides do not load .env here, because the client spawns this file with
 * `env: { ...process.env }` and that is normally enough.
 *
 * It is enough only by luck, though: server.js calls dotenv.config() at module
 * scope, but ES module imports are hoisted, so `import chatMCP from
 * "./chat-mcp.js"` runs BEFORE dotenv.config(). Today the spawn happens lazily
 * inside ensureConnected() (at request time, long after dotenv has run), so
 * SERPAPI_KEY is there. Load .env here as well and that ordering stops being
 * something the correctness of the app depends on -- and this file becomes
 * runnable on its own (`node mcp-server.js`) for debugging.
 */
dotenv.config();

const SERPAPI_KEY = process.env.SERPAPI_KEY;

// Keep in sync with the file name used by chat-mcp.js.
export const SERVER_INFO = { name: "serpapi-search", version: "1.0.0" };
export const TOOL_NAME = "search_web";

/**
 * SerpApi returns a large object: organic results, knowledge graph, related
 * questions, pagination, ads, and the search-metadata echo. The slides hand the
 * whole thing to the model with JSON.stringify().
 *
 * We keep the organic results in a compact numbered list instead. Two reasons:
 * the model only ever cites titles/snippets anyway, and a full Google response
 * is easily 100 KB -- a hundred times the size of the answer we are asking for,
 * paid on every single question. The raw JSON is still the fallback, so an
 * unexpected response shape degrades to the slides' behaviour instead of
 * silently returning nothing.
 */
export const formatSearchResults = (results) => {
  const organic = Array.isArray(results?.organic_results) ? results.organic_results : [];
  if (organic.length === 0) return JSON.stringify(results);

  return organic
    .map((item, index) => {
      const title = item.title ?? "(untitled)";
      const link = item.link ?? "";
      const snippet = item.snippet ?? "";
      return `${index + 1}. ${title}\n${link}\n${snippet}`;
    })
    .join("\n\n");
};

// 1. Create the MCP server instance.
const server = new McpServer(SERVER_INFO);

// 2. Register the tool. What the model sees is exactly this object: a name, a
//    description written for a model rather than for a human, and a zod schema
//    that is converted to JSON Schema on the wire. `num` being optional is why
//    the description has to state the default -- the schema cannot say "10".
server.registerTool(
  TOOL_NAME,
  {
    description:
      "Search the web using SerpAPI. Returns search results including organic results, snippets, and related information.",
    inputSchema: {
      query: z.string().describe("The search query to execute"),
      num: z.number().optional().describe("Number of results to return (default: 10)"),
    },
  },
  async ({ query, num = 10 }) => {
    if (!SERPAPI_KEY) {
      return {
        content: [
          {
            type: "text",
            text: "Error: SERPAPI_KEY is not set. Add it to server/.env (see .env.example) and restart the server.",
          },
        ],
      };
    }

    try {
      const results = await getJson({
        engine: "google",
        q: query,
        num,
        api_key: SERPAPI_KEY,
      });

      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(results),
          },
        ],
      };
    } catch (error) {
      // Returned, not thrown -- see the header comment.
      return {
        content: [
          {
            type: "text",
            text: `Error performing web search: ${error.message}`,
          },
        ],
      };
    }
  }
);

// 3. Wire the server to stdio and start listening.
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // console.error, not console.log -- see the header comment.
  console.error(`${SERVER_INFO.name} MCP server running on stdio`);
}

// Always run when this file is executed; this is needed when spawned as a child
// process (the slides' comment).
//
// The `isMainModule` guard is the one line we add to the slides' version. The
// slides call main() unconditionally, which is correct for a child process but
// makes the file un-importable: `import server from "./mcp-server.js"` would
// connect stdin/stdout and hang forever, so nothing in here can be unit-tested.
// "Am I the entry point?" is true in exactly the case the slides care about
// (spawned as a child) and false in exactly the case they did not consider.
const isMainModule =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error) => {
    console.error("Fatal error in MCP server:", error);
    process.exit(1);
  });
}

export default server;
