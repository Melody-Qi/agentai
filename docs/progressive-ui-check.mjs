// Drives the running dev server with a clientId that already owns a document,
// and takes one screenshot per stage of a single question:
//
//   1. the moment Ask is pressed -- the question must be on screen with both
//      answer blocks still pending
//   2. after the RAG leg lands -- the document answer is readable, the web
//      answer is still pending
//   3. after the MCP leg lands (or gives up) -- nothing pending
//
// The stage screenshots are the point: the whole change is about what is
// visible *between* the two network calls, and a finished screen cannot show it.
import { chromium } from "file:///C:/Users/Melody/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs";

const CLIENT_KEY = "agentai-client-id";
const CLIENT_ID = "progtest01clientid";
const BASE = "http://localhost:3000";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

// localStorage is per origin, so it has to be written after the first load.
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.evaluate(
  ([key, value]) => localStorage.setItem(key, value),
  [CLIENT_KEY, CLIENT_ID]
);
await page.goto(BASE, { waitUntil: "networkidle" });
await wait(1500);

const state = async (label) => {
  const snap = await page.evaluate(() => ({
    questions: [...document.querySelectorAll(".user-bubble")].map((n) => n.innerText.trim()),
    pending: [...document.querySelectorAll(".answer-pending")].map((n) =>
      n.innerText.trim()
    ),
    rag: [...document.querySelectorAll(".rag-answer")].map((n) => n.innerText.trim()),
    mcp: [...document.querySelectorAll(".mcp-answer")].map((n) => n.innerText.trim()),
  }));
  console.log(`\n=== ${label} ===`);
  console.log("question :", JSON.stringify(snap.questions));
  console.log("pending  :", snap.pending.length, JSON.stringify(snap.pending));
  console.log("rag      :", snap.rag.length ? snap.rag[0].slice(0, 90) + "…" : "(none)");
  console.log("mcp      :", snap.mcp.length ? snap.mcp[0].slice(0, 90) + "…" : "(none)");
  return snap;
};

await state("before asking");
await page.screenshot({ path: "docs/shot-prog-0-empty.png", fullPage: true });

const input = await page.$("input.ant-input");
await input.click();
await input.type("How long does shipping take?");

// Stage 1: pressed, nothing answered yet.
await input.press("Enter");
await wait(600);
await state("just after Ask");
await page.screenshot({ path: "docs/shot-prog-1-question.png", fullPage: true });

// Stage 2: the document answer has landed, the web search has not.
await page.waitForSelector(".rag-answer", { timeout: 90000 });
await wait(400);
await state("after the RAG leg");
await page.screenshot({ path: "docs/shot-prog-2-rag.png", fullPage: true });

// Stage 3: both halves done.
await page.waitForSelector(".mcp-answer", { timeout: 90000 });
await wait(400);
await state("after the MCP leg");
await page.screenshot({ path: "docs/shot-prog-3-both.png", fullPage: true });

await browser.close();
console.log("\ndone");
