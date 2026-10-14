// Screenshot the empty state: no documents, no conversation.
import pkg from "file:///C:/Users/Melody/.workbuddy/binaries/node/workspace/node_modules/playwright/index.js";
const { chromium } = pkg;

const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded", timeout: 60000 });
// Wait for the CRA app to mount, then a beat for antd to settle.
await page.waitForSelector(".app-shell", { timeout: 60000 });
await page.waitForTimeout(1200);

// Assert the two greyscale illustrations are gone and the quiet lines are in.
const emptyCount = await page.$$eval(".ant-empty", (n) => n.length);
const libraryNote = await page
  .locator(".library-empty")
  .textContent()
  .catch(() => "(missing)");
const qaNote = await page.locator(".qa-empty").textContent().catch(() => "(missing)");

console.log("antd <Empty> illustrations on page:", emptyCount, emptyCount === 0 ? "(gone, good)" : "(STILL THERE)");
console.log("library note :", String(libraryNote).trim());
console.log("qa note      :", String(qaNote).trim());

await page.screenshot({ path: "docs/shot-empty-clean.png", fullPage: false });
await browser.close();
console.log("saved docs/shot-empty-clean.png");
