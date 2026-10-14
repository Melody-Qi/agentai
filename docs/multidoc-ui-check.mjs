// Renders the running dev server with a known clientId so the two documents
// uploaded through the API are visible, then asks one cross-document question.
//
// It does not drive the antd upload control. Seeding localStorage is enough
// because App.js restores its library from GET /documents on mount, and that
// is the code path under test here anyway: the library, the checkboxes and the
// question that goes out with several docIds attached.
import { chromium } from "file:///C:/Users/Melody/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs";

const CLIENT_KEY = "agentai-client-id";
const CLIENT_ID = "md-test-03";
const BASE = "http://localhost:3000";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

// localStorage is per origin, so it has to be written after the first load.
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.evaluate(
  ([key, value]) => localStorage.setItem(key, value),
  [CLIENT_KEY, CLIENT_ID]
);
await page.goto(BASE, { waitUntil: "networkidle" });
await wait(1500);

console.log("=== document rows rendered ===");
const rows = await page.$$eval(".library-row", (nodes) =>
  nodes.map((n) => n.innerText.replace(/\s+/g, " ").trim())
);
rows.forEach((r) => console.log(" -", r));
console.log("rows:", rows.length);

await page.screenshot({ path: "shot1-library.png", fullPage: true });

// Ask across both documents. Tick everything first so the request carries two
// docIds regardless of what the restore-on-mount logic picked.
const boxes = await page.$$(".library-row .ant-checkbox-input");
console.log("checkboxes:", boxes.length);
for (const box of boxes) {
  const checked = await box.isChecked();
  if (!checked) await box.click();
}
await wait(400);

const input = await page.$("input.ant-input");
await input.click();
await input.type("How long does shipping to Canada take?");
await input.press("Enter");

// Two model round trips (rag + its neighbours) can take a while.
await page.waitForSelector(".rag-answer", { timeout: 90000 });
await wait(1200);

console.log("=== answer ===");
console.log((await page.$eval(".rag-answer", (n) => n.innerText)).trim());
console.log("=== sources shown ===");
console.log(
  (await page.$$eval(".answer-sources", (n) => n.map((x) => x.innerText.trim()))).join(" | ")
);

// Markdown check. The model decides whether to emit asterisks on any given run,
// so this is only meaningful when it did; `sawLiteral` records which case it was.
for (const cls of [".rag-answer", ".mcp-answer"]) {
  const info = await page.$eval(cls, (n) => ({
    text: n.innerText,
    strong: n.querySelectorAll("strong").length,
    paras: n.querySelectorAll("p").length,
    lists: n.querySelectorAll("ul,ol").length,
  }));
  console.log(
    `${cls}: <strong>=${info.strong} <p>=${info.paras} list=${info.lists} ` +
      `rawAsterisks=${(info.text.match(/\*\*/g) || []).length} ` +
      `startsWithSpace=${/^\s/.test(info.text)}`
  );
}

const libTags = await page.$$eval(".library-row .ant-tag", (n) =>
  n.map((x) => x.innerText.trim())
);
console.log("=== library metadata tags ===");
console.log(libTags.join(" | "));

await wait(1500);
await page.screenshot({ path: "shot2-answer.png", fullPage: true });

await browser.close();
console.log("done");
