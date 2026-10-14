// Verifies how the two answer bubbles RENDER, independent of the network.
//
// The MCP web-search step currently has no timeout (see server.js:279), so when
// serpapi stalls every question stalls with it -- real answers are unreachable
// and rendering cannot be observed. This stubs GET /chat and replays a canned
// payload, which is the part under test: what reaches the bubble after the fetch.
//
// The markdown here is modelled on what the models actually emitted earlier:
// bold labels, a bulleted list, a numbered list and a bare URL.
import { chromium } from "file:///C:/Users/Melody/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const RAG =
  "The refund window is **30 days** from delivery, and digital goods cannot be " +
  "refunded once downloaded.\n\nHere is how it works:\n\n- contact support first\n" +
  "- ship the item in its **original packaging**\n- wait up to 5 business days\n\n" +
  "See https://example.com/refunds for detail.";

const MCP =
  "**Helpful Answer:** carriers publish their own windows.\n\n1. **USPS**: 7 business days\n" +
  "2. **UPS**: 5 business days\n\nThird line after a blank line.";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

await page.route("http://localhost:5001/chat*", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ragAnswer: RAG,
      mcpAnswer: MCP,
      sources: ["test-refund-policy.pdf", "test-shipping-handbook.pdf"],
    }),
  });
});

await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
await page.evaluate(
  ([k, v]) => localStorage.setItem(k, v),
  ["agentai-client-id", "md-test-03"]
);
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await wait(1200);

const input = await page.$("input.ant-input");
await input.click();
await input.type("What is the refund window?");
await input.press("Enter");
await page.waitForSelector(".rag-answer strong", { timeout: 20000 });
await wait(800);

for (const cls of [".rag-answer", ".mcp-answer"]) {
  const info = await page.$eval(cls, (n) => ({
    strong: n.querySelectorAll("strong").length,
    paras: n.querySelectorAll("p").length,
    lists: n.querySelectorAll("ul,ol").length,
    items: n.querySelectorAll("li").length,
    links: n.querySelectorAll("a").length,
    rawStars: (n.innerText.match(/\*\*/g) || []).length,
    leading: JSON.stringify(n.innerText.slice(0, 24)),
    height: Math.round(n.getBoundingClientRect().height),
  }));
  console.log(cls, JSON.stringify(info));
}

// Newlines must still break lines: removing pre-wrap would silently join them.
const breaks = await page.$eval(".rag-answer", (n) => n.innerText.split("\n").length);
console.log("rag newlines preserved (expect > 3):", breaks);

await page.screenshot({ path: "shot-markdown.png", fullPage: true });
await browser.close();
console.log("done");
