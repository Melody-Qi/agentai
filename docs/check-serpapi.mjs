// Quota check for SerpAPI. Prints only counts and timings -- never the key.
//
// Why the key is safe here: it is read from server/.env by dotenv and only ever
// interpolated into a request this script sends to SerpAPI itself. Nothing logs it.
//
// Run from anywhere:      node docs/check-serpapi.mjs
// Only part 2 spends one search out of the monthly allowance.
import "dotenv/config";

const key = process.env.SERPAPI_KEY;
if (!key) {
  console.log("SERPAPI_KEY not set in server/.env");
  process.exit(0);
}

console.log("=== 1) account (free: does not spend a search) ===");
{
  const t0 = Date.now();
  try {
    const res = await fetch(`https://serpapi.com/account.json?api_key=${key}`, {
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json();
    console.log(`  latency      : ${Date.now() - t0}ms   HTTP ${res.status}`);
    if (res.ok) {
      console.log(`  plan         : ${body.plan_name}`);
      console.log(`  per month    : ${body.searches_per_month}`);
      console.log(`  searches left: ${body.total_searches_left}`);
      console.log(`  this hour    : ${body.this_hour_searches}`);
      const left = Number(body.total_searches_left ?? 0);
      if (left <= 0) console.log("  >>> QUOTA EXHAUSTED: all requests now fail with 429");
      else if (left < 20) console.log("  >>> nearly out of quota");
    } else {
      console.log("  body:", JSON.stringify(body).slice(0, 300));
    }
  } catch (error) {
    console.log(`  FAILED ${Date.now() - t0}ms: ${error.name} ${String(error.message).slice(0, 120)}`);
  }
}

console.log("");
console.log("=== 2) one real search (spends 1 search) ===");
{
  const url =
    "https://serpapi.com/search.json" +
    `?engine=google&q=${encodeURIComponent("USPS international shipping days to Canada")}` +
    `&num=3&api_key=${key}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const body = await res.json();
    console.log(`  latency      : ${Date.now() - t0}ms   HTTP ${res.status}`);
    if (res.ok) {
      console.log(`  organic hits : ${body.organic_results?.length ?? 0}`);
      console.log(`  first title  : ${(body.organic_results?.[0]?.title ?? "").slice(0, 70)}`);
    } else {
      console.log("  body:", JSON.stringify(body).slice(0, 300));
    }
  } catch (error) {
    console.log(`  FAILED ${Date.now() - t0}ms: ${error.name} ${String(error.message).slice(0, 120)}`);
  }
}
