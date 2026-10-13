// opsis-live-contract.ts — NOT shipped. Checks the live Opsis API against what lib/opsis.ts expects.
//
//   export OPSIS_API_KEY=opsis_live_...        # your key, in YOUR shell only — never paste it into a chat
//   deno run --allow-net --allow-env opsis-live-contract.ts                       # FREE: health, capabilities, me, credits
//   deno run --allow-net --allow-env opsis-live-contract.ts --search username:<handle-you-may-look-up>
//
// Default mode costs NOTHING (every endpoint it calls is documented as free). `--search kind:value` POSTs ONE real
// search (1 credit; with subscription fallback OFF and 0 API credits it is expected to answer 402 and cost 0) and
// polls it to completion (~60-90 s). Use a handle you are entitled to look up — your own is ideal.
//
// Output is the raw JSON with these removed: the key, `user_id`, and every result `value`/`metadata`
// (a search prints result KEYS and a platform list, not the account URLs).

const BASE = "https://api.useopsis.com";
const KEY = Deno.env.get("OPSIS_API_KEY") ?? "";
const argv = Deno.args;
const searchArg = argv[argv.indexOf("--search") + 1];

// Applied to EVERY logged response. A search response can already carry a terminal run with its accumulated results
// (the production client supports that shape), so `results` is reduced to its shape at any depth, and the value-bearing
// keys are withheld wherever else they appear. Only structure is printed — never account URLs or metadata.
const WITHHELD_KEYS = new Set(["user_id", "value", "metadata"]);
const redact = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => {
      if (WITHHELD_KEYS.has(k)) return [k, "<withheld>"];
      if (k === "results" && Array.isArray(x)) {
        const rows = x as Array<Record<string, unknown>>;
        return [k, { count: rows.length, keys: [...new Set(rows.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : [])))].sort(), values_withheld: true }];
      }
      return [k, redact(x)];
    }));
  }
  return v;
};

async function call(label: string, path: string, init: RequestInit = {}, auth = true) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Accept: "application/json", ...(auth && KEY ? { Authorization: `Bearer ${KEY}` } : {}), ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  let body: unknown = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = { non_json: text.slice(0, 200) }; }
  console.log(`\n## ${label}  →  HTTP ${res.status}`);
  console.log(JSON.stringify(redact(body), null, 2));
  return { status: res.status, body: body as Record<string, unknown> };
}

await call("GET /v1/health (public)", "/v1/health", {}, false);
await call("GET /v1/capabilities (public)", "/v1/capabilities", {}, false);

if (!KEY) {
  console.log("\nOPSIS_API_KEY is not set in this shell — only the two public endpoints were checked.");
  Deno.exit(0);
}

await call("GET /v1/me", "/v1/me");
const credits = await call("GET /v1/credits", "/v1/credits");
const c = credits.body ?? {};
// A verdict needs POSITIVE evidence of spendable credit. A failed request, a changed or missing shape, or a zero balance
// with the fallback on but no subscription credits is NOT "accepted" — it is either UNKNOWN or a 402.
const api = typeof c.api_credits_remaining === "number" ? c.api_credits_remaining : null;
const sub = typeof c.credits_remaining === "number" ? c.credits_remaining : null;
const fallback = c.use_subscription_credits;
const verdict = credits.status !== 200 || api === null
  ? `UNKNOWN — /v1/credits answered HTTP ${credits.status} without a numeric api_credits_remaining, so nothing is established about whether a search would be accepted.`
  : api > 0
    ? "A search should be accepted (API credits are available)."
    : fallback === true
      ? (sub === null
        ? "UNKNOWN — the subscription fallback is on but credits_remaining is missing, so spendable credit is not established."
        : sub > 0
          ? "A search should be accepted via the subscription fallback (API credits are 0)."
          : "A search will 402 (insufficient_api_credits): the fallback is on but subscription credits are also 0 — buy API credits or wait for the period to reset.")
      : fallback === false
        ? "A search will 402 (insufficient_api_credits): enable 'subscription fallback' in Opsis API settings, or buy API credits."
        : "UNKNOWN — API credits are 0 and use_subscription_credits is missing or not a boolean, so fallback is not established.";
console.log("\n## What lib/opsis.ts will conclude from /v1/credits");
console.log({
  http_status: credits.status,
  api_credits_remaining: c.api_credits_remaining,
  use_subscription_credits: c.use_subscription_credits,
  subscription_credits_remaining: c.credits_remaining,
  period_end: c.period_end,
  verdict,
});

if (searchArg && searchArg.includes(":")) {
  const [kind, ...rest] = searchArg.split(":");
  const query = rest.join(":");
  const start = await call(`POST /v1/searches (${kind}, wait:false)`, "/v1/searches", { method: "POST", body: JSON.stringify({ type: kind, query, wait: false, premium: false }) });
  const runId = String(start.body.run_id ?? "");
  if (start.status === 200 && runId) {
    const deadline = Date.now() + 120_000;
    let last: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000));
      const r = await fetch(`${BASE}/v1/searches/${runId}`, { headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" } });
      last = await r.json().catch(() => ({}));
      if (last.status === "completed" || last.status === "failed") break;
    }
    const results = Array.isArray(last.results) ? last.results as Array<Record<string, unknown>> : [];
    console.log("\n## GET /v1/searches/{run_id} — final shape (values and metadata withheld)");
    console.log(JSON.stringify({
      status: last.status, type: last.type, total_results: last.total_results, progress: last.progress,
      top_level_keys: Object.keys(last).sort(),
      result_count: results.length,
      result_keys: [...new Set(results.flatMap((x) => Object.keys(x)))].sort(),
      platforms: [...new Set(results.map((x) => x.platform))].slice(0, 25),
      confidence_range: results.length ? [Math.min(...results.map((x) => Number(x.confidence))), Math.max(...results.map((x) => Number(x.confidence)))] : null,
    }, null, 2));
  }
}
