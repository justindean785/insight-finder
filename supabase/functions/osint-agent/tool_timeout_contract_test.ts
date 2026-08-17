// tool_timeout_contract_test.ts — the STRUCTURAL contract behind every one-off
// timeout comment in cache.ts.
//
// The rule, stated in that table three separate times (oathnet_lookup,
// socialfetch_web_read, minimax_correlate) and re-learned the hard way each
// time: a tool's OUTER wrapper cap must sit ABOVE its OWN fetch budget. When it
// does not, the wrapper aborts a call the provider was about to answer, the
// finished work is discarded, and — because a timeout is what trips circuit.ts —
// ONE such call suppresses the tool for the remainder of the run.
//
// Until now that rule lived only in prose, so every new tool re-introduced the
// bug: fofa_search (20s fetch under the 12s default) and markdown_extract (30s
// under 12s) both shipped that way, and the first run of this scan found NINE
// more pre-existing violations, four with an 8s deficit and five tied exactly at
// 12s == 12s — a race whose winner is a scheduling coin-flip.
//
// This test reads the LIVE source rather than a copy of it, so it tracks the
// real call sites and cannot drift. There is deliberately NO allowlist: an
// exception list would let the next violation in silently, which is the failure
// mode this file exists to close.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DEFAULT_TOOL_TIMEOUT_MS, toolTimeoutMs } from "./cache.ts";
import { SERUS_OPERATION_DEADLINE_MS, SERUS_REQUEST_TIMEOUT_MS } from "./tools/serus_core.ts";
import { UNKNOWN_TOOL_SINK } from "./unknown-tool-guard.ts";

const SRC = Deno.readTextFileSync(new URL("./tool-registry.ts", import.meta.url));

/** Every `name: tool({ … })` inline definition, with its source body. */
function toolBodies(): Array<{ name: string; body: string }> {
  // Indentation-agnostic (`\s{2,}`, not a fixed four spaces) so re-formatting or
  // re-nesting buildTools does not silently drop tools from the scan. Verified
  // against a simulated re-indent of the whole registry.
  const starts: Array<{ name: string; at: number }> = [];
  for (const m of SRC.matchAll(/^\s{2,}([a-z_]+): tool\(\{/gm)) {
    starts.push({ name: m[1], at: m.index! });
  }
  return starts.map((s, i) => ({
    name: s.name,
    body: SRC.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : SRC.length),
  }));
}

/**
 * The tool's own per-call fetch budget: the trailing numeric argument of a
 * `fetchT(…, N)` call inside its body. Scanned by walking to the call's matching
 * close paren rather than by regex alone, so the argument shape in between
 * (object literals, nested calls) cannot cause a miss. A tool may issue several
 * fetches; the LARGEST is what the wrapper has to clear, since any of them could
 * be the one still in flight when the wrapper fires.
 *
 * COVERAGE LIMIT, stated rather than hidden: this only sees tools that pass an
 * explicit timeout to fetchT INLINE in tool-registry.ts — currently 13 of 89.
 * Tools that omit the argument get fetchT's own 12s default (equal to the
 * wrapper default, which is why the tie case below matters), and tools whose
 * HTTP lives in a helper module (oathnet.ts, serus_core.ts, tools/*.ts) are NOT
 * covered here; their caps are pinned individually in tool_timeout_caps_test.ts.
 */
function ownFetchBudgetMs(body: string): number | null {
  const budgets: number[] = [];
  let i = 0;
  while ((i = body.indexOf("fetchT(", i)) !== -1) {
    let depth = 0;
    let j = i + "fetchT".length;
    for (; j < body.length; j++) {
      const c = body[j];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    const m = body.slice(i, j + 1).match(/,\s*(\d[\d_]*)\s*\)$/);
    if (m) budgets.push(Number(m[1].replace(/_/g, "")));
    i = j + 1;
  }
  return budgets.length ? Math.max(...budgets) : null;
}

// Guards against the scan silently breaking and the contract below passing
// vacuously. The counts are the MEASURED values, not round numbers: 89 inline
// tool defs, 13 of them with an explicit inline fetchT budget.
Deno.test("timeout contract: the scan finds the tools it is supposed to police", () => {
  const bodies = toolBodies();
  assert(bodies.length >= 80, `only found ${bodies.length} tool defs — the scan regex broke`);
  const withFetch = bodies.filter((b) => ownFetchBudgetMs(b.body) !== null);
  assert(
    withFetch.length >= 13,
    `only ${withFetch.length} tools with a detectable inline fetchT budget (expected >= 13) — ` +
    `the budget scan broke, which would make the contract test below vacuously pass`,
  );
  // Named anchors: a silent scan failure cannot go unnoticed while these hold.
  for (const [name, expected] of [["fofa_search", 20_000], ["markdown_extract", 30_000]] as const) {
    const b = bodies.find((x) => x.name === name);
    assert(b, `${name} not found by the scan`);
    assert(
      ownFetchBudgetMs(b!.body) === expected,
      `${name}: expected a ${expected}ms inline fetch budget, scan read ${ownFetchBudgetMs(b!.body)}`,
    );
  }
});

Deno.test("timeout contract: every tool's wrapper cap exceeds its own fetch budget", () => {
  const violations: string[] = [];
  for (const { name, body } of toolBodies()) {
    const own = ownFetchBudgetMs(body);
    if (own === null) continue;
    const cap = toolTimeoutMs(name);
    if (cap <= own) {
      violations.push(
        `${name}: wrapper cap ${cap}ms ${cap === own ? "TIES" : "is BELOW"} its own ` +
        `${own}ms fetch budget` +
        (cap === DEFAULT_TOOL_TIMEOUT_MS ? " (inheriting the default — needs an override)" : ""),
      );
    }
  }
  assert(
    violations.length === 0,
    `${violations.length} tool(s) violate the wrapper-above-fetch contract. The wrapper will ` +
    `abort a call the provider was about to answer, the completed work is discarded, and one ` +
    `such timeout trips the circuit breaker for the rest of the run. Add an override in ` +
    `TOOL_TIMEOUT_OVERRIDE_MS (cache.ts) ABOVE the tool's own budget:\n  - ` +
    violations.join("\n  - "),
  );
});

// ---------------------------------------------------------------------------
// INJECTED tools — the blind spot this test shipped with.
//
// buildTools() defines most tools inline, but nine are attached afterwards as
// `(tools as ToolRegistry).x = x`, importing the implementation from tools/*.ts.
// The inline scan above sees NEITHER the declaration NOR the fetch budget, so
// those nine were entirely outside a contract that reported "zero exceptions".
//
// Production, 2026-08-02: gemini_vision (own fetch 25s) inherited the 12s default
// and died at 12,228ms reading a 17MB PDF. Scanning all nine then turned up a
// SECOND violation nobody had reported — pdl_person_enrich, own fetch 18s.
//
// Coverage is now: inline defs (above) + injected defs resolved through their
// import to the helper module (below). What remains outside is a tool whose HTTP
// lives behind a further indirection; the anchors keep that honest.

/** `(tools as X).name = symbol` -> { name, symbol }. */
function injectedTools(): Array<{ name: string; symbol: string }> {
  return [...SRC.matchAll(/\(tools as [A-Za-z]+\)\.([a-z_0-9]+)\s*=\s*([A-Za-z_0-9]+);/g)]
    .map((m) => ({ name: m[1], symbol: m[2] }))
    .filter((t) => t.name !== UNKNOWN_TOOL_SINK);
}

/** Resolve an imported symbol to the module path it came from. */
function moduleForSymbol(symbol: string): string | null {
  for (const m of SRC.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.\/[^"]+)"/g)) {
    const names = m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0].trim());
    if (names.includes(symbol)) return m[2];
  }
  return null;
}

/**
 * A helper module's own fetch budget: the largest `fetchT(…, N)` trailing
 * argument OR `const *TIMEOUT*_MS = N`. Both forms appear across tools/*.ts
 * (gemini_vision uses a bare setTimeout on VISION_FETCH_TIMEOUT_MS, not fetchT).
 */
function moduleFetchBudgetMs(modulePath: string): number | null {
  let body: string;
  try {
    body = Deno.readTextFileSync(new URL(modulePath, import.meta.url));
  } catch {
    return null;
  }
  const budgets = [
    ...[...body.matchAll(/\}\s*,\s*(\d[\d_]{3,})\s*\)/g)].map((m) => m[1]),
    ...[...body.matchAll(/[A-Z_]*TIMEOUT[A-Z_]*_MS\s*=\s*(\d[\d_]{3,})/g)].map((m) => m[1]),
  ].map((x) => Number(x.replace(/_/g, "")));
  return budgets.length ? Math.max(...budgets) : null;
}

// EXHAUSTIVE, EXACT expectations for every injected tool.
//
// The previous revision anchored only gemini_vision and pdl_person_enrich and
// let the contract loop `continue` past anything it could not resolve. Seven
// tools could therefore have vanished from coverage — a renamed export, a moved
// module — while both tests stayed green. That is the same blind spot this PR
// exists to close, one level up, so it is closed here rather than deferred.
//
// Every entry carries a MEASURED budget. `null` is deliberately not permitted by
// the type: it previously meant "this module has no static internal timeout",
// which was asserted for serus and was false — serus.ts delegates to
// serus_core.ts, where a 25s polling window lives. A nullable field invites that
// mistake back, so a tool with no measurable budget cannot be expressed here at
// all; it has to grow an explicit exported constant first.
const EXPECTED_INJECTED: ReadonlyArray<{ name: string; module: string; budgetMs: number }> = [
  // Serus's cost is TRANSITIVE: 10 polls x 2500ms is a 25s window on its own,
  // plus fetchRetry per-attempt network time. Its budget is the exported
  // SERUS_OPERATION_DEADLINE_MS, and serus.ts now accepts and forwards the
  // wrapper's AbortSignal so that deadline is actually enforceable.
  { name: "serus_darkweb_scan", module: "./tools/serus_core.ts",      budgetMs: 40_000 },
  // RE-MEASURED 2026-08-16: 18_000 -> 30_000. The old budget was not a
  // measurement of the provider, it was a measurement of our own abort. Direct
  // probes with the production key returned HTTP 200 with real records at 20.5s
  // (/search/intelligence/email) and 13.8s (/search/intelligence/phone), while
  // every logged Indicia failure was our `timed out` at 18.0-18.2s — a 7-day
  // ledger of 4 ok / 16 failed. The wrapper caps in cache.ts move 20s -> 32s in
  // step, preserving the invariant that the wrapper sits ABOVE the tool's own
  // fetch budget so the tool fails cleanly first.
  { name: "indicia_email",      module: "./tools/indicia.ts",         budgetMs: 30_000 },
  { name: "indicia_phone",      module: "./tools/indicia.ts",         budgetMs: 30_000 },
  { name: "indicia_person",     module: "./tools/indicia.ts",         budgetMs: 30_000 },
  { name: "indicia_address",    module: "./tools/indicia.ts",         budgetMs: 30_000 },
  { name: "indicia_web_dbs",    module: "./tools/indicia.ts",         budgetMs: 30_000 },
  { name: "indicia_hudsonrock", module: "./tools/indicia.ts",         budgetMs: 30_000 },
  { name: "pdl_person_enrich",  module: "./tools/peopledatalabs.ts",  budgetMs: 18_000 },
  { name: "gemini_vision",      module: "./tools/gemini_vision.ts",   budgetMs: 25_000 },
  // GeoSeer image geolocation. Own fetch budget 50s (observed 7-45s in `fast`
  // mode); the cache.ts wrapper sits at 58s, ABOVE it, so the tool aborts cleanly
  // first and the wrapper never orphans an un-signalled request.
  //
  // This entry is the whole reason this contract exists. GeoSeer shipped to the
  // mirror and was deployed with a cache.ts wrapper cap but no entry here, so this
  // test was RED at the deployed commit — and the mirror runs no CI, so nothing
  // caught it. Backporting through canonical CI is what surfaced it.
  { name: "geoseer_geolocate",  module: "./tools/geoseer.ts",         budgetMs: 50_000 },
];

Deno.test("timeout contract: the injected-tool set is exactly the expected ten", () => {
  // An eleventh injected tool added without a measured budget must fail here
  // rather than silently join the registry outside the contract.
  const found = injectedTools().map((t) => t.name).sort();
  assertEquals(
    found,
    EXPECTED_INJECTED.map((t) => t.name).sort(),
    "the injected-tool set changed. Add the new tool to EXPECTED_INJECTED with its MEASURED " +
      "internal budget (or null if it genuinely has none) and give it a TOOL_TIMEOUT_OVERRIDE_MS " +
      "entry above that budget.",
  );
});

// serus_darkweb_scan is imported from ./tools/serus.ts, but its budget lives one
// hop further on in ./tools/serus_core.ts. Declaring the indirection explicitly
// beats letting the scanner silently follow (or fail to follow) it.
const BUDGET_INDIRECTION: Readonly<Record<string, string>> = {
  serus_darkweb_scan: "./tools/serus.ts",
};

Deno.test("timeout contract: every injected tool resolves to its expected module", () => {
  for (const { name, module } of EXPECTED_INJECTED) {
    const t = injectedTools().find((x) => x.name === name);
    assert(t, `${name} is no longer attached to the registry`);
    const mod = moduleForSymbol(t!.symbol);
    assert(mod, `${name}: symbol ${t!.symbol} resolves to no import — a rename would silently drop it from the contract`);
    assertEquals(mod, BUDGET_INDIRECTION[name] ?? module, `${name} moved module`);
  }
});

Deno.test("timeout contract: every injected tool's internal budget is exactly as measured", () => {
  for (const { name, module, budgetMs } of EXPECTED_INJECTED) {
    // Serus is asserted against its NAMED EXPORT, not a regex scrape — a scraper
    // that cannot follow serus.ts -> serus_core.ts is exactly how this entry came
    // to claim `null`, and a regex that can silently stop matching is how the
    // whole contract goes vacuous.
    const actual = name === "serus_darkweb_scan" ? SERUS_OPERATION_DEADLINE_MS : moduleFetchBudgetMs(module);
    assertEquals(
      actual,
      budgetMs,
      `${name}: expected a ${budgetMs}ms budget in ${module}, measured ${actual}`,
    );
  }
});

Deno.test("timeout contract: the Serus deadline is a real exported constant, not a comment", () => {
  assertEquals(typeof SERUS_OPERATION_DEADLINE_MS, "number");
  assertEquals(SERUS_OPERATION_DEADLINE_MS, 40_000);
  assertEquals(SERUS_REQUEST_TIMEOUT_MS, 12_000);
  assert(
    SERUS_REQUEST_TIMEOUT_MS < SERUS_OPERATION_DEADLINE_MS,
    "a single request may not be allowed to consume the whole operation deadline",
  );
  assert(
    toolTimeoutMs("serus_darkweb_scan") > SERUS_OPERATION_DEADLINE_MS,
    `serus wrapper cap ${toolTimeoutMs("serus_darkweb_scan")}ms must EXCEED its ${SERUS_OPERATION_DEADLINE_MS}ms internal deadline, ` +
      `or the wrapper fires first and Serus keeps polling unsupervised`,
  );
});

Deno.test("timeout contract: the Serus tool actually forwards the wrapper's abort signal", () => {
  // A deadline that the wrapper cannot reach is not a bound. Pinned at source
  // because the failure is silent: execute() simply ignored its second argument.
  const src = Deno.readTextFileSync(new URL("./tools/serus.ts", import.meta.url));
  assert(
    /execute:\s*async\s*\([^)]*\},\s*opts\s*\)/.test(src),
    "serus execute() no longer accepts the AI SDK options argument — the abort signal cannot reach runSerusScan",
  );
  assert(/abortSignal/.test(src), "serus execute() no longer forwards abortSignal");
  const core = Deno.readTextFileSync(new URL("./tools/serus_core.ts", import.meta.url));
  assert(/signal\?:\s*AbortSignal/.test(core), "runSerusScan no longer accepts a signal");
  assert(/sleep\(intervalMs,\s*signal\)/.test(core), "the poll sleep is no longer abortable");
  assert(/headers,\s*signal\s*\}/.test(core), "poll requests no longer carry the signal");
});

Deno.test("timeout contract: injected tools clear their own fetch budget — no silent skips", () => {
  const violations: string[] = [];
  for (const { name, module, budgetMs } of EXPECTED_INJECTED) {
    const cap = toolTimeoutMs(name);
    if (cap <= budgetMs) {
      violations.push(
        `${name}: wrapper cap ${cap}ms ${cap === budgetMs ? "TIES" : "is BELOW"} its own ${budgetMs}ms fetch budget in ${module}` +
        (cap === DEFAULT_TOOL_TIMEOUT_MS ? " (inheriting the default — needs an override)" : ""),
      );
    }
  }
  assert(
    violations.length === 0,
    `${violations.length} INJECTED tool(s) violate the wrapper-above-fetch contract. These are attached ` +
    `after buildTools() and their budgets live in tools/*.ts, which is why the inline scan misses them. ` +
    `Add an override in TOOL_TIMEOUT_OVERRIDE_MS (cache.ts):\n  - ` + violations.join("\n  - "),
  );
});

Deno.test("timeout contract: the two caps this PR sets are pinned exactly", () => {
  assertEquals(toolTimeoutMs("gemini_vision"), 45_000);
  assertEquals(toolTimeoutMs("pdl_person_enrich"), 20_000);
  assert(toolTimeoutMs("gemini_vision") > 25_000, "gemini_vision cap no longer clears its 25s fetch budget");
  assert(toolTimeoutMs("pdl_person_enrich") > 18_000, "pdl_person_enrich cap no longer clears its 18s fetch budget");
});
