// P0 regression: the breach_exposure collapse must be SUBJECT-SCOPED.
//
// The collapse (0e04239) emitted `Breach exposure (${via})` — subject-agnostic.
// The dedup key is checkpointKey(kind, value), applied thread-wide via
// loadSeenArtifactKeys. So when an investigation pivots to a SECOND selector in
// the same thread and re-runs the same provider, the second subject's exposure
// produced the identical value, collided on the key, and was silently dropped —
// a data-loss path #405 itself introduced. On main (one artifact per corpus
// name) two subjects never collide, because the corpus names differ.
//
// Fix: anchor the value on the QUERIED selector (from the tool input, with an
// output-echo fallback). These tests fail before the fix and pass after.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractFindings, extractStepFindings } from "../../functions/osint-agent/auto-persist-findings.ts";

const exposure = (out: Array<{ kind: string; value: string; context?: Record<string, unknown> }>) =>
  out.find((f) => f.kind === "breach_exposure");

// ---- THE P0 GUARD: two subjects, one provider, one step ---------------------
Deno.test("extractStepFindings: two subjects on the same provider yield TWO exposures", () => {
  // Two rapidapi-style breach lookups in one step, on different emails. The tool
  // echoes the queried email at data.email (see tools/breach.ts). Before the fix
  // both collapse to `Breach exposure (hibp_style)` and the step's within-run
  // dedup keeps only ONE. After the fix each carries its own subject.
  const step = extractStepFindings([
    {
      toolName: "rapidapi_breach_search",
      input: { email: "subject.a@example.com" },
      output: { ok: true, data: { email: "subject.a@example.com", breaches: [{ name: "Chegg" }, { name: "Dubsmash" }] } },
    },
    {
      toolName: "rapidapi_breach_search",
      input: { email: "subject.b@example.com" },
      output: { ok: true, data: { email: "subject.b@example.com", breaches: [{ name: "Zynga" }] } },
    },
  ]);

  const exposures = step.filter((f) => f.kind === "breach_exposure");
  assertEquals(exposures.length, 2, "each subject must keep its own breach_exposure — no cross-subject collision");
  const values = exposures.map((e) => e.value).sort();
  assert(values[0].includes("subject.a@example.com"), "exposure A must be scoped to subject A");
  assert(values[1].includes("subject.b@example.com"), "exposure B must be scoped to subject B");
  // Distinct dedup keys is the actual invariant that closes the P0.
  assert(values[0] !== values[1], "the two exposures must not share a value/dedup key");
});

// ---- subject from INPUT (the tool did not echo it in the output) ------------
Deno.test("extractFindings: breach_check scopes the exposure to the input selector", () => {
  // leakcheck/breach_check does NOT echo the queried email in its output, so the
  // subject can ONLY come from the input. This is the tool the production sample
  // showed leaking.
  const out = extractFindings(
    "breach_check",
    { ok: true, data: { found: 1, sources: [{ name: "Ordersnapp.com" }], success: true } },
    { email: "Locked.Out@Example.com" },
  );
  const exp = exposure(out);
  assert(exp, "a breach_exposure row must be emitted");
  assertEquals(exp!.value, "Breach exposure: locked.out@example.com (breach_check)");
  assertEquals(exp!.context?.queried_selector, "locked.out@example.com");
  assertEquals(exp!.context?.breach_corpora, ["Ordersnapp.com"]);
});

// ---- subject from OUTPUT echo (no input threaded) ---------------------------
Deno.test("extractFindings: rapidapi scopes from data.email when no input is passed", () => {
  const out = extractFindings("rapidapi_breach_search", {
    ok: true,
    data: { email: "echo@example.com", breaches: [{ name: "Canva" }] },
  });
  const exp = exposure(out);
  assert(exp, "a breach_exposure row must be emitted");
  assertEquals(exp!.value, "Breach exposure: echo@example.com (hibp_style)");
  assertEquals(exp!.context?.queried_selector, "echo@example.com");
});

// ---- subject NEVER anchored on a DISCOVERED value ---------------------------
Deno.test("extractFindings: never anchors a breach_exposure on a DISCOVERED email", () => {
  // extractedData.emails is a value FOUND IN the breach — possibly another
  // person in the same corpus — not the subject queried. With no input and no
  // query echo, NO exposure may borrow it. (A top-level breaches[] here also
  // trips the generic branch, so assert across every exposure, not just one.)
  const out = extractFindings("serus_darkweb_scan", {
    ok: true,
    breaches: [{ name: "LinkedIn" }],
    extractedData: { emails: ["someone.else@breachdump.com"] },
  });
  const exposures = out.filter((f) => f.kind === "breach_exposure");
  assert(exposures.length >= 1, "a breach_exposure row must be emitted");
  for (const exp of exposures) {
    assert(!exp.value.includes("someone.else"), "must NOT borrow the discovered email as the subject");
    assertEquals(exp.context?.queried_selector, null);
  }
  // The discovered email is still surfaced as its own artifact — just not as the
  // exposure's subject.
  assert(out.some((f) => f.kind === "email" && f.value === "someone.else@breachdump.com"));
});

// ---- back-compat: no subject determinable anywhere → unchanged form ---------
Deno.test("extractFindings: with no input and no query echo, the value is unchanged", () => {
  const out = extractFindings("breach_check", {
    ok: true, data: { found: 1, sources: [{ name: "Adobe" }], success: true },
  });
  const exp = exposure(out);
  assertEquals(exp!.value, "Breach exposure (breach_check)");
  assertEquals(exp!.context?.queried_selector, null);
});
