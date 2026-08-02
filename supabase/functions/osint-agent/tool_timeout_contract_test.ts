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

Deno.test("timeout contract: the injected-tool scan actually resolves modules", () => {
  const injected = injectedTools();
  assert(injected.length >= 9, `expected >= 9 injected tools, found ${injected.length}`);
  // Named anchors with their MEASURED budgets — a silent resolution failure here
  // would make the contract below vacuous for exactly the tools it was blind to.
  for (const [name, expected] of [["gemini_vision", 25_000], ["pdl_person_enrich", 18_000]] as const) {
    const t = injected.find((x) => x.name === name);
    assert(t, `${name} not found among injected tools`);
    const mod = moduleForSymbol(t!.symbol);
    assert(mod, `${name}: could not resolve module for symbol ${t!.symbol}`);
    assertEquals(
      moduleFetchBudgetMs(mod!),
      expected,
      `${name}: expected a ${expected}ms budget in ${mod}`,
    );
  }
});

Deno.test("timeout contract: injected tools also clear their own fetch budget", () => {
  const violations: string[] = [];
  for (const { name, symbol } of injectedTools()) {
    const mod = moduleForSymbol(symbol);
    if (!mod) continue;
    const own = moduleFetchBudgetMs(mod);
    if (own === null) continue;
    const cap = toolTimeoutMs(name);
    if (cap <= own) {
      violations.push(
        `${name}: wrapper cap ${cap}ms ${cap === own ? "TIES" : "is BELOW"} its own ${own}ms ` +
        `fetch budget in ${mod}` +
        (cap === DEFAULT_TOOL_TIMEOUT_MS ? " (inheriting the default — needs an override)" : ""),
      );
    }
  }
  assert(
    violations.length === 0,
    `${violations.length} INJECTED tool(s) violate the wrapper-above-fetch contract. These are ` +
    `attached after buildTools() and their budgets live in tools/*.ts, which is why the inline ` +
    `scan misses them. Add an override in TOOL_TIMEOUT_OVERRIDE_MS (cache.ts):\n  - ` +
    violations.join("\n  - "),
  );
});
