// unproven_linkage_test.ts — the invariant that makes PROMOTION quarantine safe.
//
// Since 2026-09-12 a `subject_unlinked` selector may be dispatched. The whole
// safety case rests on one property: AUTHORITY IS NOT INHERITED. Everything a
// tainted lookup returns must itself be quarantined, or this change is a
// straight regression to the hole #433 closed — a stranger's profiles
// persisting at full subject authority, joining identity clusters and reaching
// the report.
//
// The write-path stamp in `auto-persist-findings.ts` keys on QUERY SHAPE and
// therefore CANNOT cover this: `username_sweep` on a harvested username is not
// a name-only query. These tests drive `extractFindings` — the shipped
// extractor — over realistic tool output, rather than asserting the helpers in
// isolation, because "does a persisted row come out quarantined" is the only
// question that matters.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { extractFindings } from "./auto-persist-findings.ts";
import {
  UNPROVEN_LINKAGE_KEY,
  derivedUnlinkedContext,
  unprovenLinkageFromOutput,
  unprovenLinkageMarker,
} from "./lib/unproven-linkage.ts";

const PARENT = unprovenLinkageMarker("username", "ufland40", "harvested from a name-only query");

/** A tool result carrying the taint the dispatch wrapper attaches. */
function taintedOutput(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, _runtime: { selector: "ufland40", [UNPROVEN_LINKAGE_KEY]: PARENT } };
}

/** The same result with no taint — the control. */
function cleanOutput(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, _runtime: { selector: "ufland40" } };
}

const SWEEP_BODY = {
  ok: true,
  found: [
    { platform: "GitHub", url: "https://github.com/ufland40", username: "ufland40" },
    { platform: "Reddit", url: "https://reddit.com/u/ufland40", username: "ufland40" },
  ],
};

Deno.test("marker round-trips off a tool result", () => {
  assertEquals(unprovenLinkageFromOutput(taintedOutput(SWEEP_BODY)), PARENT);
  assertEquals(unprovenLinkageFromOutput(cleanOutput(SWEEP_BODY)), null);
  // Defensive shapes the step envelope really produces.
  assertEquals(unprovenLinkageFromOutput(null), null);
  assertEquals(unprovenLinkageFromOutput("a string"), null);
  assertEquals(unprovenLinkageFromOutput([]), null);
  assertEquals(unprovenLinkageFromOutput({ _runtime: {} }), null);
  assertEquals(unprovenLinkageFromOutput({ _runtime: { [UNPROVEN_LINKAGE_KEY]: {} } }), null);
});

Deno.test("⛔ THE INVARIANT: every finding from a tainted lookup is quarantined", () => {
  const findings = extractFindings("username_sweep", taintedOutput(SWEEP_BODY), { username: "ufland40" });
  assert(findings.length > 0, "the fixture must actually yield findings, or this test proves nothing");
  for (const f of findings) {
    const ctx = (f.context ?? {}) as Record<string, unknown>;
    assertEquals(
      ctx.subject_unlinked,
      true,
      `"${f.value}" (${f.kind}) persisted WITHOUT quarantine — a stranger's row would reach the report`,
    );
    assert(
      String(ctx.subject_unlinked_reason ?? "").includes("unproven"),
      "the reason must say the linkage is unproven",
    );
    assertEquals(ctx.unproven_linkage_parent, "username:ufland40", "provenance must name the parent selector");
  }
});

Deno.test("the CONTROL: the identical lookup WITHOUT the taint is not quarantined", () => {
  // Without this, the test above could pass because the extractor quarantines
  // everything from username_sweep for some unrelated reason.
  const findings = extractFindings("username_sweep", cleanOutput(SWEEP_BODY), { username: "ufland40" });
  assert(findings.length > 0);
  const anyQuarantined = findings.some(
    (f) => ((f.context ?? {}) as Record<string, unknown>).subject_unlinked === true,
  );
  assertEquals(anyQuarantined, false, "a clean lookup must still produce ordinary evidence");
});

Deno.test("a MORE SPECIFIC existing reason is preserved, and gains the parent pointer", () => {
  // A name-only query that is ALSO dispatched on a tainted selector keeps the
  // reason that explains it best; the parent is recorded for release/audit.
  const body = taintedOutput({
    ok: true,
    results: [{ name: "Tristen Ufland", email: "someone.else@example.test" }],
  });
  const findings = extractFindings("oathnet_lookup", body, { type: "name", value: "Tristen Ufland" });
  for (const f of findings) {
    const ctx = (f.context ?? {}) as Record<string, unknown>;
    assertEquals(ctx.subject_unlinked, true);
    assertEquals(ctx.unproven_linkage_parent, "username:ufland40");
    // The name-only reason is more specific than the derived one and must win.
    assert(
      !String(ctx.subject_unlinked_reason ?? "").startsWith("derived from a lookup on"),
      `a name-only row must keep its own reason, got: ${ctx.subject_unlinked_reason}`,
    );
  }
});

Deno.test("the derived reason names the parent and what would release it", () => {
  const ctx = derivedUnlinkedContext(PARENT);
  const reason = String(ctx.subject_unlinked_reason);
  assert(reason.includes('username "ufland40"'), "an analyst must see WHICH selector is unproven");
  assert(reason.includes("harvested from a name-only query"), "the parent's own reason must carry through");
  assert(/corroborated or an analyst confirms/.test(reason), "it must say what clears it");
  assertEquals(ctx.subject_unlinked, true);
});

Deno.test("the stamp uses the EXISTING quarantine vocabulary, so every reader honours it", () => {
  // Deliberately NOT a new flag. `isExcluded` (lib/cluster.ts), the frontend's
  // `isClusterIneligible`, the dispatch guard and the report's collision
  // section all key on `subject_unlinked`. A new key would have to be taught to
  // six readers and the one that was missed would be the leak.
  const ctx = derivedUnlinkedContext(PARENT);
  assertEquals(ctx.subject_unlinked, true);
  assertEquals(typeof ctx.subject_unlinked_reason, "string");
});

Deno.test("cache.ts wires the taint onto the SHARED runtime meta, not one return path", async () => {
  const src = await Deno.readTextFile(new URL("./cache.ts", import.meta.url));
  const baseAt = src.indexOf("const runtimeMetaBase = {");
  const keyAt = src.indexOf(`[UNPROVEN_LINKAGE_KEY]: unprovenLinkage`);
  assert(baseAt > 0 && keyAt > baseAt, "the marker must ride runtimeMetaBase");
  // Every return path spreads runtimeMetaBase, so a cached replay of the same
  // quarantined selector cannot come back clean and promote.
  assert(src.includes("...(unprovenLinkage ?"), "it must be attached conditionally on the base meta");
});

Deno.test("auto-persist wires the stamp, and runs it over the FINAL finding set", async () => {
  const src = await Deno.readTextFile(new URL("./auto-persist-findings.ts", import.meta.url));
  assert(src.includes("unprovenLinkageFromOutput(output)"), "the extractor must read the marker");
  assert(src.includes("derivedUnlinkedContext("), "and apply the stamp");
  // It must run AFTER the name-only stamp so the more specific reason wins.
  const nameOnlyAt = src.indexOf("if (nameOnly) {");
  const derivedAt = src.indexOf("const derivedParent = unprovenLinkageFromOutput(output);");
  assert(nameOnlyAt > 0 && derivedAt > nameOnlyAt, "the derived stamp must run after the name-only stamp");
});
