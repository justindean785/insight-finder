#!/usr/bin/env -S deno run --allow-read --no-npm --node-modules-dir=false
// `--no-npm --node-modules-dir=false` are REQUIRED, not tidiness: deno sees the
// repo's package.json, tries to install the whole npm tree, and dies on a
// sandbox cache write ("Failed caching npm package 'iconv-lite'"). This script
// imports nothing from npm, so the integration is pure cost.
//
// Runner for the post-deploy benchmark audit. All I/O lives here; every
// judgement lives in benchmark-audit-policy.ts, which is unit-tested by
// src/test/benchmark-audit-policy.test.ts.
//
//   ./scripts/benchmark-audit.ts dump.json --deployed-at 2026-08-17T14:47:04Z
//
// Deno (not node) to match scripts/measure-metadata-source.ts and because it
// runs TypeScript directly — the repo has no tsx and needs no new dependency.
// Produce the dump with scripts/benchmark-collect.js (browser, no credentials).
//
// The report deliberately keeps THREE things apart, because conflating them is
// the failure this harness exists to prevent:
//   measured    — a number straight off the rows
//   verified    — the changed path ran AND behaved
//   unexercised — the path never ran, so nothing is proven either way
// An unexercised fix printed as a pass is how "14 aborts at 18s" nearly got
// reported as a live regression when all 14 predated the deploy.

import {
  auditDisclosure,
  authorityDistribution,
  countErrorSignatures,
  REAL_CONFIDENCE_CEILING,
  reconcileArtifacts,
  reportAcrossDeploy,
  summarizeLedger,
  type ArtifactRow,
  type ToolCallRow,
} from "./benchmark-audit-policy.ts";

const args = [...Deno.args];
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: ./scripts/benchmark-audit.ts <dump.json> [--deployed-at ISO] [--our-cap-ms N]");
  Deno.exit(2);
}
const flag = (name: string, dflt: string | null): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

interface Dump {
  collectedAt?: string;
  windowStart?: string;
  threadId?: string | null;
  artifacts?: ArtifactRow[];
  toolCalls?: ToolCallRow[];
  totals?: { artifactsAll?: number | null; metaAll?: number | null };
  caseMetrics?: Array<{ artifacts?: number }> | null;
}

const dump = JSON.parse(Deno.readTextFileSync(file)) as Dump;
const deployedAt = flag("deployed-at", null);
const ourCapMs = Number(flag("our-cap-ms", "30000"));

const artifacts = dump.artifacts ?? [];
const toolCalls = dump.toolCalls ?? [];
const totals = dump.totals ?? {};

const line = (s = "") => console.log(s);
const h = (s: string) => {
  line();
  line(s);
  line("-".repeat(s.length));
};

line(`benchmark audit — dump ${dump.collectedAt ?? "?"}, window from ${dump.windowStart ?? "?"}`);
if (dump.threadId) line(`scoped to thread ${dump.threadId}`);
if (!deployedAt) line("no --deployed-at given: counts only, exercise status cannot be judged");

h("Artifact reconciliation");
const recon = reconcileArtifacts(artifacts);
for (const [k, v] of Object.entries(recon)) line(`  ${k.padEnd(26)} ${v}`);
line(`  -> ${recon.pctReal}% of the raw count is distinct substantive evidence`);

h("Authority distribution");
const auth = authorityDistribution(artifacts);
line(`  confidence: ${JSON.stringify(auth.confidence)}`);
line(`  quarantined: ${auth.quarantined}   collisions: ${auth.collisions}`);
if (auth.aboveRealCeiling.length) {
  line(`  !! ${auth.aboveRealCeiling.length} row(s) above the real ceiling (${REAL_CONFIDENCE_CEILING}):`);
  for (const r of auth.aboveRealCeiling.slice(0, 10)) {
    line(`       ${r.kind} @ ${r.confidence} — ${String(r.value).slice(0, 60)}`);
  }
} else {
  line(`  no row exceeds the real ceiling (${REAL_CONFIDENCE_CEILING})`);
}

h("G2 — hygiene disclosure");
const disc = auditDisclosure(artifacts);
if (!disc.strippedRows.length) {
  line("  UNEXERCISED — no row carried status_assertion_stripped, so G2 never ran");
} else {
  line(`  ${disc.strippedRows.length} stripped row(s); ${disc.invariantViolations.length} violation(s)`);
  for (const v of disc.invariantViolations.slice(0, 5)) {
    line(`  !! ${v.kind}: altered with NO value_before_hygiene retained`);
  }
}

h("Tool ledger");
const led = summarizeLedger(toolCalls);
line(`  ${led.total} calls — ${JSON.stringify(led.byOutcome)} (ok ${led.okRate}%)`);
line(`  known error signatures: ${JSON.stringify(countErrorSignatures(toolCalls))}`);

if (deployedAt) {
  h(`Exercise status since ${deployedAt}`);
  const after = toolCalls.filter((c) => c.created_at > deployedAt);
  line(`  traffic after deploy: ${after.length} calls`);
  const families = [...new Set(toolCalls.map((c) => c.tool_name.split("_")[0]))].sort();
  for (const fam of families) {
    const calls = toolCalls.filter((c) => c.tool_name.startsWith(fam));
    const rep = reportAcrossDeploy(calls, { deployedAt, ourCapMs, totalEventsAfter: after.length });
    const mark = rep.verdict.status === "exercised" ? "OK " : rep.verdict.status === "inconclusive" ? "?  " : "-- ";
    line(`  ${mark}${fam.padEnd(16)} before=${rep.before.length} after=${rep.after.length}  ${rep.verdict.reason}`);
    const causes = Object.entries(rep.causesAfter).filter(([c]) => c !== "none");
    if (causes.length) line(`      causes after deploy: ${JSON.stringify(Object.fromEntries(causes))}`);
  }
}

if (dump.caseMetrics && totals.artifactsAll != null && totals.metaAll != null) {
  h("get_case_metrics vs raw counts (#472 migration)");
  const rpcTotal = dump.caseMetrics.reduce((s, r) => s + Number(r.artifacts ?? 0), 0);
  const applied = totals.artifactsAll - totals.metaAll;
  line(`  rpc total ${rpcTotal}   raw ${totals.artifactsAll}   meta ${totals.metaAll}`);
  line(`  predicted if applied ${applied} / if not ${totals.artifactsAll}`);
  if (totals.metaAll === 0) line("  INCONCLUSIVE — no meta rows; both hypotheses predict the same total");
  else if (rpcTotal === applied) line("  APPLIED");
  else if (rpcTotal === totals.artifactsAll) line("  NOT applied");
  else line("  !! matches neither prediction");
}

line();
