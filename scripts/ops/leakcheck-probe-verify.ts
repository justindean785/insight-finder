// leakcheck-probe-verify.ts — NOT shipped. A CONTROLLED before/after check of the one assumption PR #701 rests on:
//
//   "A VALID LeakCheck key on a 2-character query answers HTTP 400 'Too short query (< 3 characters)' and spends NO quota."
//
//   export LEAKCHECK_API_KEY=...        # your key, in YOUR shell only — never paste it into a chat
//   deno run --allow-net --allow-env leakcheck-probe-verify.ts                 # FREE-IF-THE-ASSUMPTION-HOLDS: probe only, 5 requests
//   deno run --allow-net --allow-env leakcheck-probe-verify.ts --spend-2       # the controlled quota test: spends exactly 2 real lookups
//
// What --spend-2 does (nothing else spends quota):
//   1. one real lookup of a nonsense address            → reads `quota` = Q0 from the successful response
//   2. FIVE probe requests (2-char query), 500 ms apart  → records each status + LeakCheck's error text
//   3. one real lookup of a different nonsense address   → reads `quota` = Q1
//   PASS iff  Q0 - Q1 === 1  (only step 3 consumed quota; the five probes cost nothing)
//        AND  all five probes were HTTP 400 with the documented "Too short query" message.
//   If Q0 - Q1 is 6 the probe COSTS A LOOKUP EACH and #701 must stay off. Anything else prints UNVERIFIED.
// Without --spend-2 it only reports what the five probes answered (status/text) — it cannot see quota.
// The key is never printed. Lookups use reserved-TLD nonsense addresses, not anyone's real address.

const KEY = Deno.env.get("LEAKCHECK_API_KEY") ?? "";
if (!KEY) { console.error("LEAKCHECK_API_KEY is not set in this shell."); Deno.exit(2); }
const SPEND = Deno.args.includes("--spend-2");
const BASE = "https://leakcheck.io/api/v2/query/";
const headers = { "X-API-Key": KEY, Accept: "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(q: string) {
  const res = await fetch(BASE + encodeURIComponent(q), { headers });
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  return { status: res.status, body };
}
const err = (b: Record<string, unknown> | null) => (typeof b?.error === "string" ? String(b.error).slice(0, 90) : null);

async function lookup(label: string, q: string) {
  const r = await get(q);
  const quota = typeof r.body?.quota === "number" ? r.body.quota : null;
  console.log(`${label}: HTTP ${r.status}  success=${r.body?.success}  found=${r.body?.found}  quota=${quota}  error=${err(r.body)}`);
  return { ...r, quota };
}

let q0: number | null = null;
if (SPEND) {
  const a = await lookup("real lookup #1 (before)", `leakcheck-probe-verify-a-${Date.now()}@example.invalid`);
  if (a.status !== 200 || a.quota === null) {
    console.log("\nABORT: the first real lookup did not succeed with a numeric quota — nothing further was spent.");
    Deno.exit(1);
  }
  q0 = a.quota;
  await sleep(500);
}

const probes: Array<{ status: number; text: string | null; quota: unknown }> = [];
for (let i = 1; i <= 5; i++) {
  const r = await get("ab");
  probes.push({ status: r.status, text: err(r.body), quota: r.body?.quota ?? null });
  console.log(`probe ${i}: HTTP ${r.status}  error=${err(r.body)}  quota_field=${r.body?.quota ?? "absent"}`);
  await sleep(500);
}
const allShort = probes.every((p) => p.status === 400 && /too short/i.test(p.text ?? ""));
const anyQuotaField = probes.some((p) => p.quota !== null);

let q1: number | null = null;
if (SPEND) {
  await sleep(500);
  const b = await lookup("real lookup #2 (after) ", `leakcheck-probe-verify-b-${Date.now()}@example.invalid`);
  q1 = b.status === 200 ? b.quota : null;
}

console.log("\n==== VERDICT ====");
console.log(`all five probes were HTTP 400 "Too short query": ${allShort}`);
console.log(`any probe response carried a quota field:        ${anyQuotaField}`);
if (SPEND) {
  const delta = q0 !== null && q1 !== null ? q0 - q1 : null;
  console.log(`quota before=${q0} after=${q1} delta=${delta}  (expected 1: only the second real lookup)`);
  if (allShort && !anyQuotaField && delta === 1) console.log("PASS — the probe answered the documented 400 five times and cost no quota. It is safe to opt in.");
  else if (delta !== null && delta > 1) console.log(`FAIL — the five probes cost ~${delta - 1} quota unit(s). Leave LEAKCHECK_KEY_PROBE_ENABLED UNSET.`);
  else console.log("UNVERIFIED — the results do not establish the assumption. Leave the probe OFF and send this output to review.");
} else {
  console.log(allShort ? "Probe answers look right, but quota was not measured — re-run with --spend-2 before opting in." : "UNVERIFIED — the probe did not answer the documented 400 five times. Leave the probe OFF.");
}
