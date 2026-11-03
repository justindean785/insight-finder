/**
 * auto-persist-findings.ts — force-persist high-signal artifacts from tool
 * outputs, INDEPENDENT of whether the model called `record_artifacts`.
 *
 * WHY
 *   The isolate is routinely CPU-killed on long runs BEFORE the model calls
 *   `record_artifacts`. Findings that live only in the tool's JSON output are
 *   then discarded — the user sees "78 evidence, 0 artifacts". This module
 *   extracts a conservative, well-shaped subset of findings (URLs, breach
 *   names, discovered emails, social handles) from each tool return and writes
 *   them into `public.artifacts` as `auto_recorded: true` rows, flagged low-
 *   confidence and capped by the existing confidence engine. The model can
 *   still promote them via `record_artifacts` for higher confidence.
 *
 * SAFETY
 *   - Only whitelisted tool families are scanned (never memory / recording /
 *     planner tools, never tools that already auto-record like dork_harvest).
 *   - Only whitelisted kinds are emitted (url, email, breach, social_account,
 *     github_repo, phone, domain, ip_address). Secrets / breach payloads /
 *     minor-flagged fields are never surfaced.
 *   - Every row goes through `buildAutoRecordedRow` + `scrubArtifactRows`, the
 *     same integrity path used by dork_harvest.
 *   - Per-step cap prevents a single tool from flooding the artifact table.
 *   - Deduped against a caller-owned `Set<string>` so a re-run / recovery /
 *     duplicate tool call never inserts twice.
 */

import { BREACH_EXPOSURE_KINDS, breachExposureGuardDisabled, isBreachCapableTool } from "./lib/breach-exposure-guard.ts";
import { buildAutoRecordedRow } from "./auto-record-integrity.ts";
import { scrubArtifactRows } from "./safety.ts";
import { checkpointKey } from "./incremental-persist.ts";
import { isNullishLiteral } from "./lib/nullish-literal.ts";
import { derivedUnlinkedContext, unprovenLinkageFromOutput } from "./lib/unproven-linkage.ts";
import { canonicalPhoneValue, composeAddress, normPhoneE164 } from "./lib/selector-normalize.ts";

/** Hard ceiling on auto-persisted rows PER tool call. Prevents one exhaustive
 *  scrape (Wayback captures, GitHub search hits) from writing hundreds of rows. */
export const MAX_AUTO_PERSIST_PER_TOOL_CALL = 25;

/** Corpus names retained inside a single breach_exposure artifact. Far above the
 *  worst case observed in production (88 corpora in one thread), so truncation is
 *  a disclosed edge case rather than routine lossiness. */
export const MAX_BREACH_CORPORA_PER_EXPOSURE = 250;
/** Hard ceiling on auto-persisted rows PER step across all tool calls. */
export const MAX_AUTO_PERSIST_PER_STEP = 60;

/** Page size and hard scan ceiling for the thread-wide dedup set. Mirrors
 *  `RECOVERY_ARTIFACT_PAGE_SIZE`'s reasoning in recovery.ts: an unbounded select
 *  is silently truncated by PostgREST's row cap, and a truncated dedup set
 *  re-inserts rows it should have blocked. */
export const SEEN_ARTIFACT_PAGE_SIZE = 500;
export const SEEN_ARTIFACT_SCAN_MAX = 5000;

/** Tool names that already own their persistence path (do NOT double-record). */
export const AUTO_PERSIST_TOOL_DENYLIST = new Set<string>([
  // Explicit persistence & meta:
  "record_artifacts", "record_artifact", "record_finding_corroboration",
  "save_agent_memories", "memory_recall", "memory_save",
  "triage_seed", "plan_pivots", "minimax_plan_pivots", "minimax_correlate",
  // Tools that auto-record their own artifacts internally:
  "dork_harvest", "gemini_deep_dork",
  // Generic broad-search / meta discovery — too noisy to auto-persist blindly.
  // (The model still records the good hits via record_artifacts.)
  "google_dorks", "minimax_web_search", "perplexity_search", "exa_search",
  "osint_navigator_search", "osint_navigator_advise",
  // Vision / read tools — the surfaced URL is the INPUT, not a finding.
  "gemini_vision", "jina_reader_scrape", "http_fingerprint", "firecrawl_scrape",
  // Context.dev search / scrape / people search — same class as exa_search and jina:
  // the model records the good hits via record_artifacts. People results are broker
  // leads; scanning them blindly would file strangers' names against the subject.
  "contextdev_web_search", "contextdev_scrape", "contextdev_people_search",
  // Attribution / integrity guards — no user-facing findings.
  "attribution_check", "date_sanity_check",
]);

/**
 * The subset of the denylist that is excluded for NOISE, not for correctness —
 * eligible for the zero-evidence escalation below.
 *
 * WHY THIS EXISTS. The denylist above conflates two very different reasons to
 * skip a tool, and that conflation is a durability hole. Recording, memory,
 * planner and auto-recording tools must NEVER be scanned: their output is not
 * findings, or is already persisted, so extracting from them would be wrong at
 * any time. But the broad search and read tools are skipped only because
 * auto-persisting them "blindly" is too noisy — the standing assumption being
 * that the model will pick the good hits and call `record_artifacts`.
 *
 * When the model does not, that assumption leaves NO durability path at all. A
 * run made entirely of these tools persists nothing, the persistence nudge is
 * advisory, and if the isolate is CPU-killed the analyst gets zero artifacts
 * from real completed work (production, 2026-08-06: three nudges,
 * `record_artifact_calls: 0`, `artifact_count: 0`, CPU Time exceeded).
 *
 * So these become extractable ONLY in the escalated state — see the call site in
 * index.ts, which requires BOTH that the model has fanned out without recording
 * AND that the thread still holds zero artifacts. Noise is the price of the
 * alternative being total evidence loss, and it is paid only in the state where
 * the alternative is certain.
 *
 * Everything omitted here stays permanently excluded, escalation or not.
 */
export const ESCALATION_ELIGIBLE_TOOLS = new Set<string>([
  "google_dorks", "minimax_web_search", "perplexity_search", "exa_search",
  "osint_navigator_search", "osint_navigator_advise",
  "gemini_vision", "jina_reader_scrape", "http_fingerprint", "firecrawl_scrape",
  "contextdev_web_search", "contextdev_scrape", "contextdev_people_search",
]);

/** Ceiling on candidates held in memory awaiting the escalation gate. 2x the
 *  per-step cap: enough to carry several barren steps, small enough that a long
 *  run cannot grow the isolate's memory without bound. */
export const MAX_ESCALATION_BUFFER = 120;

/**
 * Hold escalation-eligible candidates from steps that have ALREADY happened.
 *
 * WHY A BUFFER IS REQUIRED, not a nicety. The escalation gate can only open once
 * `persistenceNudgeCount > 0`, and the nudge fires only after the model has fanned
 * out several times without recording. Everything found in those earlier steps was
 * denied by the denylist and never held anywhere, so it was already gone by the
 * time the gate opened. Worse, `buildIntermediateStepPlan` narrows the nudge
 * step's `activeTools` to `["record_artifacts"]` alone — so on the very step that
 * opens the gate there are no search results to extract, and if the model then
 * declines or fails and the run dies, escalation salvages NOTHING. Without this
 * buffer the fix only ever covered searches performed AFTER the first nudge.
 *
 * The buffer is memory-only and bounded: nothing is written until the gate opens.
 * Keyed by `checkpointKey(kind, value)` so a value seen across several steps is
 * held once, matching the dedup the DB path applies later.
 */
export function bufferEscalationCandidates(
  buffer: Map<string, ExtractedFinding & { toolName: string }>,
  candidates: readonly (ExtractedFinding & { toolName: string })[],
  cap: number = MAX_ESCALATION_BUFFER,
): { added: number; dropped: number } {
  let added = 0;
  let dropped = 0;
  for (const f of candidates) {
    if (buffer.size >= cap) { dropped++; continue; }
    const k = checkpointKey(f.kind, f.value);
    if (buffer.has(k)) continue;
    buffer.set(k, f);
    added++;
  }
  return { added, dropped };
}

/** Rows a single escalated flush may hand to persistAutoFindings.
 *
 *  WHY A SEPARATE BUDGET. persistAutoFindings applies NO row-count cap — it maps
 *  every non-duplicate finding straight to an insert. extractStepFindings is
 *  bounded by MAX_AUTO_PERSIST_PER_STEP, but a flush merges the buffer (up to 120)
 *  with the current step (up to 60), so an unbounded drain could hand it 180 rows
 *  in one call and quietly bypass the per-step ceiling the rest of the pipeline
 *  respects. The overflow is RETAINED, not dropped: it stays in the buffer and
 *  goes out on the next escalated flush. */
export const MAX_ESCALATION_FLUSH = MAX_AUTO_PERSIST_PER_STEP;

/**
 * Drain the buffer in front of this step's findings, de-duplicated across both and
 * bounded by `budget`.
 *
 * Buffered candidates lead because they are the OLDEST evidence and therefore the
 * most likely to be lost — if the budget truncates anything, it must not be the
 * rows that have already survived several steps unpersisted.
 *
 * Whatever does not fit goes BACK into the buffer rather than being discarded,
 * including any of this step's own findings displaced by older ones. The buffer is
 * naturally bounded by this: merged is at most MAX_ESCALATION_BUFFER +
 * MAX_AUTO_PERSIST_PER_STEP, so the retained remainder can never exceed
 * MAX_ESCALATION_BUFFER.
 */
export function drainEscalationBuffer(
  buffer: Map<string, ExtractedFinding & { toolName: string }>,
  stepFindings: readonly (ExtractedFinding & { toolName: string })[],
  budget: number = MAX_ESCALATION_FLUSH,
): { rows: Array<ExtractedFinding & { toolName: string }>; retained: number } {
  const merged: Array<[string, ExtractedFinding & { toolName: string }]> = [];
  const seen = new Set<string>();
  for (const f of [...buffer.values(), ...stepFindings]) {
    const k = checkpointKey(f.kind, f.value);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push([k, f]);
  }
  const rows = merged.slice(0, Math.max(0, budget)).map(([, f]) => f);
  buffer.clear();
  for (const [k, f] of merged.slice(Math.max(0, budget))) buffer.set(k, f);
  return { rows, retained: buffer.size };
}

/** What the per-step backstop should do. `runPersist` drives the ONE branch in
 *  index.ts that starts the persist task. */
export type BackstopDecision = {
  runPersist: boolean;
  reason: "finalize_owns_persistence" | "step_findings" | "buffered_escalation" | "nothing_to_do";
};

/**
 * Decide whether the auto-persist backstop runs this step. Pure, and PRODUCTION
 * CALLS THIS — it is not a description of the control flow, it is the control flow.
 *
 * WHY IT EXISTS AS A FUNCTION. The first version of the pre-nudge buffer was
 * wired under two conditions that between them made it unreachable in exactly the
 * scenario it was written for:
 *
 *   1. the whole backstop was gated on `toolResults.length > 0`, and
 *   2. the persist task was gated on `stepFindings.length > 0`.
 *
 * A DECLINED NUDGE STEP produces no tool result at all (activeTools is narrowed to
 * ["record_artifacts"], and the model declined), so (1) skipped the block outright.
 * A later BARREN STEP — a Wayback timeout, an errored search — extracts nothing, so
 * (2) skipped the task. The buffer was filled and never drained, and the run still
 * died with zero artifacts.
 *
 * That defect survived a test suite because the test replayed the timeline through
 * its OWN copy of the branch logic, written slightly more permissively than the
 * shipped one. Both halves passed; the product did not work. Hence this function:
 * one definition, called by index.ts and asserted by the tests, so the two cannot
 * diverge again.
 *
 * NOTE the absence of a tool-result count. It is deliberate — the buffered case
 * MUST fire on a step that produced no tool results whatsoever.
 */
export function decideBackstopAction(input: {
  finalizeStarted: boolean;
  stepFindingCount: number;
  bufferedCount: number;
  escalated: boolean;
}): BackstopDecision {
  // Finalize owns persistence once it starts; the backstop stands aside.
  if (input.finalizeStarted) return { runPersist: false, reason: "finalize_owns_persistence" };
  if (input.stepFindingCount > 0) return { runPersist: true, reason: "step_findings" };
  // The case the first version missed: nothing extractable NOW, but evidence is
  // held from earlier steps and the gate is open.
  if (input.escalated && input.bufferedCount > 0) {
    return { runPersist: true, reason: "buffered_escalation" };
  }
  return { runPersist: false, reason: "nothing_to_do" };
}

/** Kinds we will auto-persist. Nothing sensitive is on this list — the identity
 *  kinds below (name/address/organization/username) are the SUBJECT's resolved
 *  identity, the whole point of the investigation; breach payloads (passwords,
 *  hashes, SSNs, PINs) are NEVER mapped to a kind and so never become artifacts. */
const ALLOWED_KINDS = new Set<string>([
  // NB: bare "breach" is DELIBERATELY ABSENT — see collapseBreachCorpora below.
  // A breach CORPUS NAME is provenance for an exposure, not a finding about the
  // subject, and emitting one artifact per corpus is what buried the evidence
  // board (measured: 708 corpus rows across 45 threads, mean 43.5 per thread,
  // max 88; one scan was 47 of 83 artifacts, every one at confidence 55).
  "url", "email", "breach_exposure", "social_account", "github_repo", "github_account",
  "phone", "domain", "ip_address", "leak_paste", "document",
  "name", "address", "organization", "username",
  // Collapsed harvest shapes — one artifact carries many underlying rows in metadata.
  "social_footprint", "bulk_corpus_harvest",
]);

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const URL_RE = /^https?:\/\/[^\s<>"']{4,2048}$/i;

export type ExtractedFinding = {
  kind: string;
  value: string;
  /** Free-form context that will land in artifact.metadata (already safe). */
  context?: Record<string, unknown>;
  /** 0..100. Auto-persist defaults are intentionally LOW (evidence caps apply). */
  rawConfidence?: number;
};

/** Value normalization + validation for the allowed kinds. Returns the canonical
 *  form to store, or null if the value is invalid / not safe to persist. */
export function normalizeFinding(kind: string, value: unknown): { kind: string; value: string } | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  // A null-shaped tool field ("NULL", "n/a", "none", "undefined") is not a
  // selector. One reached production as a username at confidence 45.
  if (isNullishLiteral(v)) return null;
  const k = kind.toLowerCase();
  if (!ALLOWED_KINDS.has(k)) return null;
  switch (k) {
    case "url":
    case "leak_paste":
    case "document": {
      if (!URL_RE.test(v)) return null;
      // Strip common tracking params for stable dedup.
      try {
        const u = new URL(v);
        for (const p of ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid"]) u.searchParams.delete(p);
        return { kind: k, value: u.toString() };
      } catch { return null; }
    }
    case "email": {
      if (!EMAIL_RE.test(v)) return null;
      return { kind: "email", value: v.toLowerCase() };
    }
    case "domain": {
      const d = v.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
      return { kind: "domain", value: d };
    }
    case "ip_address": {
      if (!/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{2,}$/i.test(v)) return null;
      return { kind: "ip_address", value: v };
    }
    case "phone": {
      const digits = v.replace(/[^\d+]/g, "");
      if (digits.replace(/\D/g, "").length < 7) return null;
      // CANONICAL E.164 (2026-08-28). Dedup is `checkpointKey(kind, value)` —
      // exact equality — so the spelling IS the identity. A measured run wrote
      // +19175550123, 19175550123 and 9175550123 as three artifacts in three
      // cluster slots for one number, then the clusterer folded them back
      // together, because this fold ran only at cluster time.
      //
      // The fold deliberately does NOT collapse 79175550123 (a Russian +7
      // number sharing ten digits with the US one) — see selector-normalize.ts.
      //
      // FALLBACK, not a narrowing: normPhoneE164 returns null below 8 digits,
      // and this case has always accepted 7. Keeping the digits-only value in
      // that band preserves admission exactly as before — this change is about
      // identity, never about which numbers are allowed in.
      return { kind: "phone", value: canonicalPhoneValue(digits) ?? digits };
    }
    case "breach_exposure": {
      // The VALUE is a stable per-provider label, never a count — dedup is by
      // (kind, value) via checkpointKey, so embedding "47 corpora" here would
      // mint a second row the moment a later step found a 48th.
      if (v.length > 200) return null;
      return { kind: "breach_exposure", value: v };
    }
    case "github_account":
    case "github_repo":
    case "social_account": {
      if (v.length > 200) return null;
      return { kind: k, value: v };
    }
    case "name": {
      const nm = v.replace(/\s+/g, " ").trim();
      if (nm.length < 3 || nm.length > 120) return null;
      if (!/[A-Za-z]/.test(nm)) return null;   // must contain letters
      if (/^\d+$/.test(nm)) return null;       // never a bare number
      // HANDLE-SHAPED VALUES ARE NOT PEOPLE (2026-07-27).
      // Breach corpora return a bag of loosely-labelled fields, and the "name"
      // column routinely carries usernames, display names and password-adjacent
      // junk. The old rules — has a letter, isn't a bare number — accepted all of
      // it, so a dark-web scan on youngcl17@gmail.com persisted `Daycron123`,
      // `Napster6` and `Dreamcast6` as PERSON NAMES at confidence 40, and an
      // earlier case recorded the literal string "Do Forget To Subscribe".
      // Those then seed identity clusters and appear in the report's Identity
      // section as candidate people.
      // Real person names do not contain digits, and do not carry handle/path
      // punctuation. Rejecting here is the safe direction: a false negative loses
      // one weak artifact, a false positive invents a human being. The value is
      // still available to the model in the tool output — this only stops it being
      // durably recorded AS a name.
      if (/\d/.test(nm)) return null;
      if (/[_@/\\]/.test(nm)) return null;
      return { kind: "name", value: nm };
    }
    case "address": {
      const ad = v.replace(/\s+/g, " ").trim();
      if (ad.length < 6 || ad.length > 200) return null;
      if (!/\d/.test(ad) || !/[A-Za-z]/.test(ad)) return null; // a real address has both
      return { kind: "address", value: ad };
    }
    case "organization": {
      const org = v.replace(/\s+/g, " ").trim();
      if (org.length < 2 || org.length > 200) return null;
      if (!/[A-Za-z0-9]/.test(org)) return null;
      return { kind: "organization", value: org };
    }
    case "username": {
      const un = v.replace(/^@+/, "").trim();
      if (un.length < 2 || un.length > 120) return null;
      if (/\s/.test(un)) return null;          // usernames have no whitespace
      return { kind: "username", value: un };
    }
    case "social_footprint":
    case "bulk_corpus_harvest": {
      if (v.length < 4 || v.length > 240) return null;
      return { kind: k, value: v.replace(/\s+/g, " ").trim() };
    }
  }
  return null;
}

function pushUrl(out: ExtractedFinding[], url: unknown, ctx: Record<string, unknown>) {
  const n = normalizeFinding("url", url);
  if (n) out.push({ kind: n.kind, value: n.value, context: ctx, rawConfidence: 30 });
}

/** Kill switch: false restores one artifact per swept platform URL. */
export const SWEEP_COLLAPSE_ENABLED = true;
/** Below this many hits, individual URLs are still legible — don't collapse. */
export const SWEEP_COLLAPSE_MIN_HITS = 3;

/** Kill switch: false restores one quarantined artifact per bulk-corpus identity. */
export const BULK_CORPUS_COLLAPSE_ENABLED = true;
/** Identity rows retained inside a collapsed bulk-corpus summary. */
export const MAX_BULK_CORPUS_ITEMS_RETAINED = 250;

/** True when a row carries the bulk-corpus quarantine stamp from `coCorpusCtx`. */
export function isBulkCorpusQuarantine(ctx: Record<string, unknown> | undefined): boolean {
  return /bulk corpus return/i.test(String(ctx?.subject_unlinked_reason ?? ""));
}

/**
 * True when a row carries the NAME-ONLY harvest stamp from `SUBJECT_UNLINKED_CTX`.
 *
 * Deliberately anchored on "harvested from", NOT on "name-only query" alone: the
 * ECHO row carries "echo of a name-only query …" and is the subject's own
 * apparent name. It must stay its own card, never fold into a stranger group.
 */
export function isNameOnlyHarvestQuarantine(ctx: Record<string, unknown> | undefined): boolean {
  return /harvested from a name-only query/i.test(String(ctx?.subject_unlinked_reason ?? ""));
}

/**
 * How many collapsible ROWS one name-only lookup may yield before the set
 * collapses to a summary row.
 *
 * ROWS, not people — this counts the flattened findings (one person routinely
 * yields four: email, phone, name, address), because by the time the collapse
 * runs the per-record grouping is gone. Twelve is therefore roughly three to
 * four same-name strangers, which is the point where enumerating them stops
 * telling an analyst anything the group heading does not.
 *
 * It is a distinct knob from BULK_HARVEST_IDENTITY_CAP because the two measure
 * different things and answer different questions: that one counts person
 * identities and asks "was this a dataset?", this one counts rows and asks "is
 * this still readable?". A bulk corpus is itself evidence — the dataset is real
 * and worth seeing enumerated. A name-only return is not: name equality proves
 * nothing about linkage.
 */
export const NAME_ONLY_HARVEST_COLLAPSE_CAP = 12;

// Input fields, in priority order, that name the selector a breach tool was
// queried ON. Every breach lookup is invoked with one of these.
const BREACH_SUBJECT_INPUT_KEYS = [
  "email", "identifierValue", "username", "handle", "phone",
  "query", "q", "value", "domain", "ip", "ip_address",
] as const;

/** Input keys that carry a CONCRETE selector — one that identifies an account,
 *  not a person. A query on any of these is subject-linked by construction:
 *  the provider matched on the selector itself. */
const CONCRETE_SELECTOR_INPUT_KEYS = [
  "email", "identifierValue", "username", "handle", "phone", "domain", "ip", "ip_address",
] as const;

/** Marker written into artifact.metadata for a row harvested from a name-only
 *  query. It is DISCLOSURE, not deletion: the row persists and stays readable on
 *  the Evidence board, but it must never join a cluster or count as evidence. */
const SUBJECT_UNLINKED_CTX = {
  subject_unlinked: true,
  subject_unlinked_reason:
    "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
} as const;

/** Reason stamped on the ROOT row — the echo of the queried name itself. Distinct
 *  from the descendant reason above because the failure is different in kind: the
 *  value is not a stranger's identifier, it is the subject's *apparent* name
 *  carried on a stranger's record. Analysts read this to understand why a name
 *  they recognise lost authority. */
const UNLINKED_ECHO_CTX = {
  subject_unlinked: true,
  subject_unlinked_reason:
    "echo of a name-only query whose queried name is not itself linked to the subject — " +
    "same-name collision axis; the matching name does not prove this record is the subject's",
} as const;

/** Reason stamped on a selector lifted from a breach-corpus row that belongs to
 *  SOMEONE ELSE. A corpus row set is co-tenanted: querying one selector returns
 *  the matching record plus, routinely, neighbours. `breachSubjectAnchor` already
 *  refuses to anchor an exposure on a discovered value for exactly this reason —
 *  "those can belong to other people in the same corpus" — but the item loop
 *  below mints phone/email/name/address from those same rows, at full subject
 *  authority.
 *
 *  MEASURED 2026-08-26: a run pivoting on +19175550123 persisted 79175550123 —
 *  a Russian +7 number off a `zoloto585.ru` row belonging to a different person
 *  — as a subject selector with its own cluster id. */
const CO_TENANT_CTX = {
  subject_unlinked: true,
  subject_unlinked_reason:
    "co-tenant row in a breach corpus — this record carries a different value in the field that " +
    "was queried, so it belongs to another person in the same dataset, not the subject",
} as const;

/** Kinds that identify a PERSON. A corpus is measured in these, never in the
 *  infrastructure, breach-name or summary rows one lookup legitimately fans out
 *  to — those describe the DATASET, and the dataset is real evidence about the
 *  thing that was queried even when its members are strangers. */
const CORPUS_IDENTITY_KINDS = new Set(["name", "email", "phone", "address", "username"]);

/**
 * How many person-identities one tool return may yield before it is a CORPUS.
 *
 * A person has one name, a handful of addresses and a phone or two. Past that,
 * a single lookup did not return the subject's record — it returned a dataset
 * the subject may or may not be in.
 *
 * MEASURED on the live corpus 2026-08-28. Of the auto-persist batches that
 * produced any identity row at all: 55 yielded 1-3, 42 yielded 4-6, 22 yielded
 * 7-10, 16 yielded 11-20 and **31 yielded 21 or more — 752 rows, 51% of every
 * person-identity auto-persist has ever written**. Fifteen sits above the whole
 * plausible single-person range (the widest real one measured is Troy B. Keith:
 * 5 emails + 4 phones + 1 address from `indicia_person`) and well under
 * MAX_AUTO_PERSIST_PER_TOOL_CALL, so a legitimately rich person record is never
 * touched and a customer list never survives.
 */
export const BULK_HARVEST_IDENTITY_CAP = 15;

/**
 * Reason stamped on a person-identity lifted out of a bulk corpus return.
 *
 * THE CASE THIS EXISTS FOR — thread `61d1eede`, 2026-08-28. A dossier claimed a
 * phone; the phone turned out to be Psyberware's corporate landline; the run
 * pivoted to `psyber.com` and OathNet returned the ISP's customer records. 21
 * mailboxes (`support@`, `dbuse@`, `lisalou@`) and 13 names (`GIGI KLAIBER`,
 * `dale buse`, `robin haynes`) persisted as SUBJECT evidence at 45%, each with
 * its own cluster id — while the same run's own contradiction row, written a
 * minute earlier, read "NO Carlos Morales in any record".
 *
 * Neither existing gate can reach it, and both look like they should:
 *   - `SUBJECT_UNLINKED_CTX` needs a NAME-only query. This was a domain query.
 *   - `CO_TENANT_CTX` needs a positive same-field mismatch. Querying
 *     `psyber.com` and getting `support@psyber.com` back is a MATCH on the
 *     queried field, so it correctly declines.
 * Cardinality is the signal both of them are blind to.
 */
function coCorpusCtx(n: number) {
  return {
    subject_unlinked: true,
    subject_unlinked_reason:
      `harvested from a bulk corpus return — this one lookup yielded ${n} person identities for ` +
      `a single selector, which is a dataset of many people rather than one person's record; ` +
      `appearing in that dataset is not linkage to the subject`,
  } as const;
}

/**
 * Reason stamped on the COLLAPSED summary of a name-only harvest.
 *
 * Keeps the "harvested from a name-only query" prefix on purpose: it is the mark
 * `isNameOnlyHarvestQuarantine` and the display-side grouping both key on, so the
 * summary stays classified with the rows it replaces. States the finding rather
 * than the mechanism — an analyst reading this card needs to know that the count
 * is a collision set, not a lead set.
 */
function nameCollisionCtx(n: number) {
  return {
    subject_unlinked: true,
    subject_unlinked_reason:
      `harvested from a name-only query — this lookup returned ${n} identities sharing the ` +
      `queried name; name equality is not linkage, so none of them is attributable to the ` +
      `subject without independent corroboration`,
  } as const;
}

/**
 * Does this row echo the selector that was actually queried?
 *
 * EXACT normalized equality, never containment. Containment is the trap: the
 * queried selector in the case above is `psyber.com`, and every one of the 21
 * co-tenant mailboxes CONTAINS it — a containment test would exempt the whole
 * corpus and the gate would do nothing at all. Exact equality exempts the one
 * row that genuinely is the subject's (querying a seed email and getting that
 * same email back out of its own breach corpus) and nothing else.
 */
function echoesQueriedSelector(value: string, queriedRaw: string, seedName: string): boolean {
  const v = normalizeBreachSubject(value);
  if (!v) return false;
  const q = normalizeBreachSubject(queriedRaw);
  if (q && v === q) return true;
  const s = normalizeBreachSubject(seedName);
  return !!s && v === s;
}

/**
 * Does this corpus row POSITIVELY disagree with the queried selector?
 *
 * Deliberately narrow, and deliberately asymmetric. It returns true only when
 * the row carries a non-empty value in the SAME field the query anchored on and
 * that value differs. It is false when:
 *
 *   - there is no anchor (nothing to disagree with);
 *   - the row simply lacks a phone — a genuine subject row often does not echo
 *     the queried selector at all;
 *   - the anchor is a name or username — a same-name axis is a collision
 *     question, which `queryIsNameOnly` + SUBJECT_UNLINKED_CTX already own.
 *
 * ABSENCE IS NEVER AN ACCUSATION. Stamping on a missing field would quarantine
 * genuine evidence wholesale, which is the same over-application that
 * `isSubjectUnlinked`'s strict `=== true` and G1's fail-closed rule exist to
 * prevent. An over-broad quarantine is as much a defect as a missing one.
 *
 * ⚠️ PHONE ONLY, DELIBERATELY. An email branch was implemented and REMOVED. It
 * broke `subject_relevance_gate_test.ts`'s "a selector-keyed lookup is
 * subject-linked by construction" — the #433 position that a concrete-selector
 * query is trusted and only NAME-only queries quarantine. That is a settled
 * boundary, and moving it needs sign-off, not a drive-by.
 *
 * The measured defect is a PHONE mismatch (+1917… queried, 79175550123
 * returned). There is no measured email case, and widening an integrity signal
 * past its evidence to reach a tidier result is how the other over-applications
 * in this module happened. If an email co-tenant is ever measured, that is the
 * moment to revisit the #433 boundary — with the evidence in hand.
 */
function rowContradictsAnchor(row: Record<string, unknown>, anchor: string): boolean {
  if (!anchor) return false;
  const anchorPhone = normPhoneE164(anchor);
  // `normPhoneE164` folds any 8-15 digit run, so guard on the anchor actually
  // LOOKING like a phone — otherwise a numeric-ish username would be compared
  // as one.
  if (anchorPhone && /^[+\d][\d\s().+-]*$/.test(anchor)) {
    const raw = row.phone_number ?? row.phone_national ?? row.phone_number2;
    const p = (typeof raw === "string" || typeof raw === "number") ? normPhoneE164(String(raw)) : null;
    return p !== null && p !== anchorPhone;
  }
  return false;
}

/** Split a name into comparable tokens. Punctuation and commas are separators so
 *  "Roe, Jane" and "Jane Roe" reduce to the same token set. */
function nameTokens(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);
}

/**
 * Does the investigation SEED durably link the name a tool was queried on?
 *
 * THE INVARIANT THIS ENFORCES (P0-A): name equality is not durable linkage. The
 * echo of a name-only query may keep subject authority ONLY when the queried name
 * is tied to the subject by an already-authorized mechanism. The seed is that
 * mechanism: an investigation opened ON a person name asserts that name as the
 * subject's, so echoing it back is not a claim about a stranger.
 *
 * A name HARVESTED mid-run is deliberately NOT accepted, even when it came from a
 * subject-linked branch. The row at issue belongs to whoever the provider matched
 * on the name — a same-name stranger in the failure case — and the subject's own
 * name already exists as a separate, subject-linked artifact from the branch that
 * harvested it. Quarantining the echo therefore costs no evidence.
 *
 * Matching is TOKEN-SUBSET, not substring: `detectSeedServer` classifies
 * "Jane Roe Springfield OR" as one person seed, so a query narrowed to "Jane Roe"
 * must still resolve as seed-linked. A substring predicate was tried elsewhere in
 * this codebase and produced false confirmations at scale; a token subset cannot
 * match a name the seed does not actually contain. Single-token names are refused
 * outright — one shared token is the collision axis, not linkage.
 *
 * FAILS CLOSED: an absent or unusable seed yields false, so the echo is
 * quarantined. Absence of proof is not proof of linkage.
 */
export function seedLinksQueriedName(seedName: string, queriedName: string): boolean {
  const queried = nameTokens(queriedName);
  if (queried.length < 2) return false;
  const seed = new Set(nameTokens(seedName));
  if (seed.size === 0) return false;
  return queried.every((t) => seed.has(t));
}

/** Declared `type`/`kind`/`search_type` values that name a CONCRETE selector.
 *  This is the union of the real tool enums minus `name`: oathnet_lookup is
 *  ["email","username","phone","ip","domain","name"], leakcheck_lookup is
 *  ["auto","email","username","phone","hash","domain"]. `auto` is deliberately
 *  absent — it declares nothing, so it must fall through to shape-sniffing. */
const CONCRETE_DECLARED_TYPES = new Set([
  "email", "username", "phone", "ip", "domain", "hash",
]);

/** Tools whose `query` slot holds a SEARCH EXPRESSION in a query language or a
 *  natural-language question — never a person name. Each is inherently multiword,
 *  so shape-sniffing classified every call as a person name and quarantined
 *  everything it returned. Enumerated from the real schemas in tool-registry.ts
 *  and each confirmed by probe to both produce findings and be wrongly
 *  quarantined; do NOT extend this by guessing from a tool's name.
 *
 *    github_code_search    GitHub search syntax   `widgets in:file extension:json`
 *    urlscan_search        Lucene                 `domain:example.com AND page.url:"k"`
 *    fofa_search           FOFA syntax            `domain="example.com" && port="443"`
 *    oathnet_ai_filter     NL corpus filter       `US banking users with gmail addresses`
 *    osint_navigator_query NL question ABOUT TOOLS `tools to find who registered a domain`
 *
 *  DELIBERATELY ABSENT — these are subject searches, not query languages, so a
 *  name typed into them really does return same-name-collision-prone results,
 *  which is precisely what this gate exists to disclose:
 *    deepfind_telegram_search  topic/keyword channel search
 *    oathnet_scanner           its `query` IS the selector being monitored
 *    hackertarget              its `query` IS a host/IP/domain target
 *  Also absent because AUTO_PERSIST_TOOL_DENYLIST already stops them reaching the
 *  gate at all: exa_search, minimax_web_search, osint_navigator_search. */
const FREE_TEXT_QUERY_TOOLS = new Set([
  "github_code_search",
  "urlscan_search",
  "fofa_search",
  "oathnet_ai_filter",
  "osint_navigator_query",
]);

/** Does this string look like a PERSON NAME rather than a selector? Two or more
 *  words and none of the concrete selector shapes.
 *
 *  LAST RESORT ONLY. This is a guess about a string's shape, and it is wrong in
 *  both directions (a query language reads as a name; "kyle williams 710" is a
 *  real handle). Every authoritative signal — an allowlisted free-text tool, a
 *  concrete input key, a declared concrete type — is consulted BEFORE this. */
function looksLikePersonName(v: string): boolean {
  const s = String(v ?? "").trim();
  if (!s || s.length > 120) return false;
  if (s.includes("@")) return false;                      // email
  if (/^https?:\/\//i.test(s)) return false;              // url
  if (/^\+?[\d\s().-]{7,}$/.test(s)) return false;        // phone
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return false;    // ipv4
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)) return false; // domain / host
  return /\s/.test(s);                                    // 2+ words ⇒ person name
}

/** The raw selector string this tool call queried, whatever slot it arrived in. */
function queriedSelectorRaw(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  for (const k of [...BREACH_SUBJECT_INPUT_KEYS, "name", "full_name", "person"]) {
    const v = i[k as string];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

/**
 * Was this tool queried by PERSON NAME only — with no concrete selector?
 *
 * THE INCIDENT (production, 2026-08-06): a breach-aggregator lookup keyed on a
 * person's NAME returned dozens of unrelated people, and the extractor persisted
 * 15+ of THEIR emails and usernames onto the subject's thread at confidence 45 —
 * including a K-12 school-district student address belonging to no one in the
 * investigation. The agent's own narration called the results "massive noise";
 * nothing downstream could tell, because a harvested row carried no record of how
 * weak its linkage was. (Those selectors are third parties' personal data and are
 * deliberately not reproduced here or in the fixtures.)
 *
 * A concrete selector anywhere in the input means the provider matched on that
 * selector, so results are subject-linked and NOT quarantined.
 *
 * SIGNALS, in strict priority order. Shape-sniffing is the LAST resort, never the
 * first, because it is the only one that guesses:
 *   1. an allowlisted free-text-query tool  ⇒ never a name
 *   2. a concrete selector INPUT KEY        ⇒ never a name
 *   3. a DECLARED type — authoritative in BOTH directions:
 *        concrete (email/username/phone/ip/domain/hash) ⇒ never a name
 *        name|person                                    ⇒ always a name
 *   4. a name-shaped key (name/full_name/person)
 *   5. only then, the SHAPE of an untyped generic slot
 *
 * KNOWN LIMIT (FN-1, accepted): a person name placed in a concrete slot —
 * `{username: "jane roe"}` — escapes this gate, because signal 2 trusts the
 * caller's own slot choice. Closing it would mean inferring that a name sits
 * inside a selector slot, i.e. re-introducing the prose-based inference this
 * project removed deliberately after it caused a production incident. The limit
 * is documented rather than fixed; see the characterization test in
 * subject_relevance_gate_test.ts.
 */
function queryIsNameOnly(toolName: string, input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  // 1. A query language is not a person name, however many words it has.
  if (FREE_TEXT_QUERY_TOOLS.has(toolName)) return false;
  const i = input as Record<string, unknown>;
  // 2. A concrete selector key means the provider matched on that selector.
  for (const k of CONCRETE_SELECTOR_INPUT_KEYS) {
    const v = i[k];
    if (typeof v === "string" && v.trim()) return false;
    if (typeof v === "number") return false;
  }
  // 3. An explicit typing is authoritative in BOTH directions. Tools that carry
  //    the selector in a generic `value` slot (oathnet_lookup, leakcheck_lookup)
  //    declare what it IS in `type` — believe them, and never sniff past it.
  const declared = String(i.type ?? i.kind ?? i.search_type ?? "").toLowerCase();
  if (CONCRETE_DECLARED_TYPES.has(declared)) return false;
  if (declared === "name" || declared === "person") return true;
  // 4. A name-shaped key.
  for (const k of ["name", "full_name", "person"]) {
    const v = i[k];
    if (typeof v === "string" && v.trim()) return true;
  }
  // 5. LAST RESORT: nothing declared anything, so guess from the shape of the
  //    generic slot. Everything authoritative has already been consulted.
  for (const k of ["query", "q", "value"]) {
    const v = i[k];
    if (typeof v === "string" && v.trim()) return looksLikePersonName(v);
  }
  return false;
}

/** Lowercased, bounded selector identity. Two spellings of one selector must
 *  anchor to one exposure, and checkpointKey lowercases the value anyway. */
function normalizeBreachSubject(s: string): string {
  const v = s.trim().toLowerCase();
  return v.length > 0 && v.length <= 200 ? v : "";
}

/**
 * The queried selector a breach lookup ran ON — the SUBJECT its exposure belongs
 * to. Read PRIMARILY from the tool INPUT (authoritative: it is literally what was
 * queried), with a fallback to the few output shapes that echo the query
 * (rapidapi → data.email; serus → identifierValue; generic → query).
 *
 * Deliberately NEVER reads a DISCOVERED email/handle out of the breach payload
 * (e.g. serus `extractedData.emails`, oathnet item rows) — those can belong to
 * other people in the same corpus and are not the subject. Anchoring on a
 * discovered value is how one subject's exposure would be attributed to another.
 */
function breachSubjectAnchor(o: Record<string, unknown>, input: unknown): string {
  const pick = (src: unknown, keys: readonly string[]): string => {
    if (!src || typeof src !== "object") return "";
    const rec = src as Record<string, unknown>;
    for (const k of keys) {
      const val = rec[k];
      if (typeof val === "string" && val.trim()) return val.trim();
      if (typeof val === "number" && Number.isFinite(val)) return String(val);
    }
    return "";
  };
  const fromInput = pick(input, BREACH_SUBJECT_INPUT_KEYS);
  if (fromInput) return normalizeBreachSubject(fromInput);
  const fromOutput = pick(o.data, ["email"]) || pick(o, ["identifierValue", "query"]);
  return fromOutput ? normalizeBreachSubject(fromOutput) : "";
}

function readEnvSafe(k: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(key: string): string | undefined } } }).Deno?.env.get(k);
  } catch {
    return undefined;
  }
}

/**
 * A Serus `extractedData.names` entry becomes a `name` artifact only when it has
 * at least two words. Serus's parser labels breach-record TOKENS as names: on a
 * production case (2026-10-01) one scan's `names` held a username fragment, a
 * first name, a surname and a leaked PASSWORD, and the password then printed as
 * an identity-cluster heading in the exported report. A one-word value cannot
 * stand as a person's name — everywhere else it is the `thin_name` advisory —
 * so it is not persisted as one. The breach row that carried it is untouched.
 * Kill switch, read at call time: `SERUS_NAME_FILTER_DISABLED=true`.
 */
export function serusNameAdmissible(
  n: unknown,
  env: (k: string) => string | undefined = readEnvSafe,
): boolean {
  if ((env("SERUS_NAME_FILTER_DISABLED") ?? "").trim().toLowerCase() === "true") return true;
  return typeof n === "string" && n.trim().split(/\s+/).filter(Boolean).length >= 2;
}

/** /health self-test for serusNameAdmissible. Pure; its PRESENCE proves this build is live. */
export function serusNameFilterSelfTest(
  env: (k: string) => string | undefined = readEnvSafe,
): { ok: boolean; detail: string } {
  if ((env("SERUS_NAME_FILTER_DISABLED") ?? "").trim().toLowerCase() === "true") {
    return { ok: true, detail: "LEGACY via SERUS_NAME_FILTER_DISABLED — every Serus name token is persisted" };
  }
  const ok = serusNameAdmissible("Jane Example", () => undefined) &&
    !serusNameAdmissible("Qwerty", () => undefined) && !serusNameAdmissible("  ", () => undefined);
  return ok
    ? { ok: true, detail: "Serus names need two or more words; one-word tokens are not persisted as names" }
    : { ok: false, detail: "self-test failed" };
}

/**
 * Extract findings from a single tool call's parsed output. Never throws.
 *
 * `input` is the tool-call arguments (the queried selector). Optional so the
 * per-tool unit tests can keep calling with two args; production threads it via
 * extractStepFindings so a breach exposure is scoped to the subject that was
 * actually queried.
 *
 * `subjectSeedName` is the investigation's PERSON seed, normalized — "" for a
 * run seeded on anything else. It is the only mechanism by which a queried-name
 * echo may retain subject authority (see seedLinksQueriedName). Omitting it fails
 * closed: the echo is quarantined like every other row from a name-only query.
 */
export function extractFindings(
  toolName: string,
  output: unknown,
  input?: unknown,
  subjectSeedName?: string,
  opts?: { escalated?: boolean },
): ExtractedFinding[] {
  if (AUTO_PERSIST_TOOL_DENYLIST.has(toolName) &&
      !(opts?.escalated && ESCALATION_ELIGIBLE_TOOLS.has(toolName))) return [];
  if (!output || typeof output !== "object") return [];
  const o = output as Record<string, unknown>;
  // Never extract from an explicit tool error.
  // A PARTIAL success is not a failure. dns_records makes per-type failures
  // deliberately non-fatal — it returns `ok:false` with `records` still populated
  // for every type that DID resolve, plus an `errors` map naming the ones that
  // did not. Bailing on `ok === false` alone re-collapsed that design decision and
  // silently discarded every resolved A/NS/MX record whenever one type SERVFAILed
  // or a DKIM query arrived without its selector. A hard failure still carries a
  // top-level `error` string and is still rejected below.
  const partialSuccess = !!o.records && typeof o.records === "object" &&
    !!o.errors && typeof o.errors === "object";
  if ((o.ok === false && !partialSuccess) || typeof o.error === "string") return [];

  // QUARANTINE GATE. A NAME-only query cannot establish subject linkage for
  // anything it returns — that is the same-name collision axis the rest of this
  // codebase already refuses to treat as identity (lib/cluster.ts: "Names are
  // deliberately excluded"). Rows harvested from one are LEADS, not evidence.
  const nameOnly = queryIsNameOnly(toolName, input);
  const queriedName = nameOnly ? normalizeBreachSubject(queriedSelectorRaw(input)) : "";
  // Whether the QUERIED name is itself linked to the subject. Decides only one
  // thing: may the echo of that name keep subject authority (see the stamp below).
  const queriedNameIsSubjectLinked = nameOnly &&
    seedLinksQueriedName(subjectSeedName ?? "", queriedName);

  const findings: ExtractedFinding[] = [];
  const push = (k: string, v: unknown, ctx: Record<string, unknown> = {}, conf = 30) => {
    const n = normalizeFinding(k, v);
    if (n) findings.push({ kind: n.kind, value: n.value, context: { tool: toolName, ...ctx }, rawConfidence: conf });
  };
  // Breach corpus names are COLLECTED, not pushed. Every provider branch below
  // funnels through addCorpus, and collapseBreachCorpora emits ONE
  // breach_exposure artifact per provider at the end, carrying the full list.
  // Two independent reasons this matters:
  //   1. 57% of one production board was corpus names at a single flat 55, so
  //      nothing could rank against anything else.
  //   2. extractFindings is capped at MAX_AUTO_PERSIST_PER_TOOL_CALL (25) with a
  //      hard break, so corpus names were EVICTING real identity findings from
  //      the per-call budget. Collapsing 25 names into 1 row returns 24 slots.
  const breachCorpora = new Map<string, Set<string>>();
  const addCorpus = (via: string, name: unknown) => {
    const n = typeof name === "string" ? name.trim() : "";
    if (!n || n.length > 120) return;
    let set = breachCorpora.get(via);
    if (!set) { set = new Set<string>(); breachCorpora.set(via, set); }
    set.add(n);
  };

  // 1) HIBP-style breach payloads: { data: { breaches: [{ Name|name }] } }
  const hibpBreaches = ((o.data as { breaches?: unknown } | null)?.breaches) ?? o.breaches;
  if (Array.isArray(hibpBreaches)) {
    // NOT sliced to MAX_AUTO_PERSIST_PER_TOOL_CALL: that bound exists to cap
    // ARTIFACTS, and corpora no longer become artifacts. Slicing here silently
    // dropped corpora 26+ from the exposure list — caught by the "every corpus
    // is still counted" fixture. The retention bound is
    // MAX_BREACH_CORPORA_PER_EXPOSURE, which discloses truncation.
    for (const b of hibpBreaches) {
      const name = (b as { Name?: unknown; name?: unknown })?.Name ?? (b as { name?: unknown })?.name;
      addCorpus("hibp_style", name);
    }
  }

  // 2) Perplexity / Gemini / MiniMax citations: { citations: [{url}] | [string] }
  const citations = o.citations;
  if (Array.isArray(citations)) {
    for (const c of citations.slice(0, MAX_AUTO_PERSIST_PER_TOOL_CALL)) {
      const u = typeof c === "string" ? c : (c as { url?: unknown })?.url;
      pushUrl(findings, u, { tool: toolName, via: "citation" });
    }
  }

  // 3) Generic items[]: pull url/email/handle/repo shapes.
  const items = Array.isArray(o.items) ? o.items
    : Array.isArray(o.results) ? o.results
    : Array.isArray(o.matches) ? o.matches
    : null;
  if (items) {
    for (const it of items.slice(0, MAX_AUTO_PERSIST_PER_TOOL_CALL)) {
      if (!it || typeof it !== "object") continue;
      const row = it as Record<string, unknown>;
      pushUrl(findings, row.url ?? row.link ?? row.html_url, { via: "items[]" });
      if (typeof row.email === "string") push("email", row.email, { via: "items[]" }, 40);
      if (toolName === "github_code_search" && typeof row.repo === "string") {
        push("github_repo", row.repo, { via: "items[]" }, 40);
      }
    }
  }

  // 4) GitHub user profile (github_user) → github_account + profile URL.
  if (toolName === "github_user") {
    const user = o.user as { login?: unknown; html_url?: unknown; blog?: unknown; email?: unknown } | null;
    if (user && typeof user === "object") {
      push("github_account", user.login, { via: "github_user" }, 70);
      pushUrl(findings, user.html_url, { tool: toolName, via: "profile_url" });
      if (typeof user.email === "string") push("email", user.email, { via: "github_user.email" }, 55);
      if (typeof user.blog === "string" && URL_RE.test(user.blog)) pushUrl(findings, user.blog, { tool: toolName, via: "profile_blog" });
    }
    const repos = o.repos;
    if (Array.isArray(repos)) {
      for (const r of repos.slice(0, MAX_AUTO_PERSIST_PER_TOOL_CALL)) {
        pushUrl(findings, (r as { url?: unknown })?.url, { tool: toolName, via: "repo" });
      }
    }
  }

  // 5) socialfetch_lookup — the real hit shape is data.profile (object). The
  //    earlier heuristic read data.url/profile_url/o.url, which the current API
  //    never returns, so confirmed profiles were silently dropped on killed runs.
  if (toolName === "socialfetch_lookup") {
    const data = o.data as Record<string, unknown> | null;
    const profile = (data?.profile ?? data) as Record<string, unknown> | null;
    if (profile && typeof profile === "object") {
      pushUrl(findings, profile.url ?? profile.profile_url ?? profile.link ?? o.url, { tool: toolName, via: "profile" });
      const handle = profile.username ?? profile.handle ?? profile.screen_name;
      if (typeof handle === "string") push("social_account", handle, { via: "socialfetch" }, 55);
    }
  }

  // 6) hunter_domain_search → { data: { emails: [{ value }] } }
  if (/^hunter_/.test(toolName)) {
    const emails = ((o.data as { emails?: unknown } | null)?.emails) ?? o.emails;
    if (Array.isArray(emails)) {
      for (const e of emails.slice(0, MAX_AUTO_PERSIST_PER_TOOL_CALL)) {
        const v = typeof e === "string" ? e : (e as { value?: unknown })?.value;
        push("email", v, { via: "hunter" }, 55);
      }
    }
  }

  // 7) Cert transparency subdomains (crtsh_lookup): { subdomains: [] }
  const subs = o.subdomains;
  if (Array.isArray(subs)) {
    for (const s of subs.slice(0, MAX_AUTO_PERSIST_PER_TOOL_CALL)) {
      push("domain", s, { via: "cert_transparency" }, 45);
    }
  }

  // 8) indicia_person / indicia_phone / indicia_email — the subject's resolved
  //    identity. Killed runs relied ENTIRELY on the model to record these, so a
  //    CPU-kill before synthesis lost the whole person. Third-party `associates`
  //    and the `children` COUNT are deliberately not surfaced (non-subject PII).
  if (/^indicia_/.test(toolName)) {
    const records = Array.isArray(o.records) ? o.records : [];
    for (const rec of records.slice(0, MAX_AUTO_PERSIST_PER_TOOL_CALL)) {
      if (!rec || typeof rec !== "object") continue;
      const r = rec as Record<string, unknown>;
      push("name", r.name, { via: "indicia" }, 45);
      if (Array.isArray(r.aka)) for (const a of r.aka.slice(0, 5)) push("name", a, { via: "indicia_aka" }, 40);
      if (Array.isArray(r.emails)) for (const e of r.emails) push("email", e, { via: "indicia" }, 50);
      if (Array.isArray(r.phones)) for (const p of r.phones) push("phone", p, { via: "indicia" }, 50);
      push("address", r.currentAddress, { via: "indicia_current" }, 50);
      if (Array.isArray(r.pastAddresses)) for (const a of r.pastAddresses) push("address", a, { via: "indicia_past" }, 40);
    }
  }

  // 9) serus_darkweb_scan — extractedData holds Serus's PARSED leak fields;
  //    breaches[] the breach names. Its parser is not trusted on `names`: it
  //    has labelled a password as a name (see serusNameAdmissible).
  if (toolName === "serus_darkweb_scan") {
    const ed = o.extractedData as Record<string, unknown> | null;
    if (ed && typeof ed === "object") {
      if (Array.isArray(ed.emails)) for (const e of ed.emails) push("email", e, { via: "serus" }, 45);
      if (Array.isArray(ed.phones)) for (const p of ed.phones) push("phone", String(p ?? ""), { via: "serus" }, 45);
      if (Array.isArray(ed.names)) for (const n of ed.names) if (serusNameAdmissible(n)) push("name", n, { via: "serus" }, 40);
      if (Array.isArray(ed.usernames)) for (const u of ed.usernames) push("username", u, { via: "serus" }, 45);
    }
    if (Array.isArray(o.breaches)) {
      for (const b of o.breaches) {  // full list — see the hibp note above
        const bo = b as Record<string, unknown> | null;
        const name = typeof b === "string" ? b : (bo?.name ?? bo?.Name ?? bo?.title ?? bo?.source);
        addCorpus("serus_breach", name);
      }
    }
  }

  // 10) breach_check / leakcheck_lookup — data.sources[] are the breach names.
  if (toolName === "breach_check" || toolName === "leakcheck_lookup") {
    const data = o.data as Record<string, unknown> | null;
    const sources = data && Array.isArray(data.sources) ? data.sources : [];
    for (const s of sources) {  // full list — see the hibp note above
      const so = s as Record<string, unknown> | null;
      const name = typeof s === "string" ? s : (so?.name ?? so?.Name ?? so?.title);
      addCorpus(toolName, name);
    }
  }

  // 11) oathnet_lookup — data.data.dbname_info keys/Title are the breaches;
  //     data.data.items[] are leaked records. ONLY whitelisted identity fields
  //     are read — password / password_hash / ssn / pin / encrypted_cc / salt
  //     are never referenced, so they can never become artifacts.
  if (toolName === "oathnet_lookup") {
    const dd = ((o.data as Record<string, unknown> | null)?.data) as Record<string, unknown> | null;
    if (dd && typeof dd === "object") {
      const dbInfo = dd.dbname_info as Record<string, unknown> | null;
      if (dbInfo && typeof dbInfo === "object") {
        for (const [domain, info] of Object.entries(dbInfo)) {  // full list — see the hibp note above
          const title = (info as Record<string, unknown>)?.Title;
          addCorpus("oathnet_db", (typeof title === "string" && title) ? title : domain);
        }
      }
      const items = Array.isArray(dd.items) ? dd.items : [];
      // The selector this lookup ACTUALLY ran on. A corpus returns the matching
      // record plus its neighbours, so a row that disagrees with the anchor on
      // the queried field belongs to someone else — see CO_TENANT_CTX.
      const oathnetAnchor = breachSubjectAnchor(o, input);
      for (const it of items.slice(0, MAX_AUTO_PERSIST_PER_TOOL_CALL)) {
        if (!it || typeof it !== "object") continue;
        const row = it as Record<string, unknown>;
        // DISCLOSURE, not deletion: a co-tenant row keeps its place in the
        // artifact table and the Evidence count and loses only AUTHORITY —
        // clusters, graph edges, corroboration, promotion. `isSubjectUnlinked`
        // already binds every one of those boundaries.
        const rowCtx: Record<string, unknown> = rowContradictsAnchor(row, oathnetAnchor)
          ? { via: "oathnet", ...CO_TENANT_CTX }
          : { via: "oathnet" };
        push("email", row.email, rowCtx, 45);
        const phoneRaw = row.phone_number ?? row.phone_national ?? row.phone_number2;
        if (phoneRaw != null) push("phone", String(phoneRaw), rowCtx, 45);
        const fullName = row.full_name ?? row.display_name
          ?? [row.first_name, row.middle_name, row.last_name].filter((x) => typeof x === "string" && x).join(" ");
        push("name", fullName, rowCtx, 40);
        push("username", row.username, rowCtx, 45);
        push("ip_address", row.ip, rowCtx, 40);
        if (typeof row.linkedin === "string") {
          pushUrl(findings, row.linkedin, { tool: toolName, ...rowCtx, via: "oathnet_linkedin" });
        }
        // COMPOSED, not concatenated (2026-08-28). This was a five-field
        // `.join(" ")`, which on a measured production row persisted:
        //
        //   1110 SAMPLE AVE3F 1110 SAMPLE AVE APT 3F ANYTOWN NY 10001
        //
        // — `address_street2` restating `address_street` in a different
        // spelling, run together with no separators. That string is the
        // artifact's `value`, so it is what the board, the report and the
        // export all render. composeAddress drops a redundant street line and
        // keeps BOTH when they are genuinely different.
        const addr = composeAddress({
          street: row.address_street,
          street2: row.address_street2,
          city: row.address_city ?? row.city,
          state: row.address_state ?? row.state,
          postcode: row.address_postcode ?? row.postal_code ?? row.zip,
        });
        push("address", addr, rowCtx, 45);
      }
    }
  }

  // 12) username_sweep — found[] are CONFIRMED profile hits. "Confirmed" means the
  //     page carried positive evidence of the account, NOT merely a 2xx: a soft-404
  //     (signup form / SPA shell served at 200) is reported under `unverified` and
  //     never counted here. See sweeper.ts `bodyEvidencesAccount`.
  //     The profile URL is the finding; it lives in `found`, not items/results/matches,
  //     so it was previously dropped.
  if (toolName === "username_sweep" && Array.isArray(o.found)) {
    // COLLAPSED 2026-07-27 — one artifact per HANDLE, not one per platform.
    //
    // This used to emit a separate `url` artifact for every 2xx platform hit. A
    // sweep returns ~20, and a run that sweeps four handles therefore persisted
    // ~80 rows of pypi.org/user/<h>, weibo.com/<h>, hashnode.com/@<h> — each
    // presented to the analyst as an individual piece of evidence at confidence
    // 30. Measured on the youngcl17@gmail.com run: 62 of 103 artifacts (60%) were
    // sweep URLs, the Evidence badge read 99+, and the report closed with
    // "Key Findings: No findings recorded yet." The real signals — the breach
    // hits and three alternate handles — were buried under account-existence
    // checks.
    //
    // A sweep hit is NOT independent evidence. It proves a string is registered on
    // a site, nothing about who owns it, which is why every one of these caps at
    // username_sweep confidence anyway. The FOOTPRINT is the finding; the
    // individual URLs are its supporting detail and belong in metadata, where the
    // model and the analyst can still read every one of them.
    const hits: string[] = [];
    for (const hit of o.found.slice(0, MAX_AUTO_PERSIST_PER_TOOL_CALL)) {
      if (!hit || typeof hit !== "object") continue;
      const h = hit as Record<string, unknown>;
      if (h.found === false) continue;
      const n = normalizeFinding("url", h.url);
      if (n) hits.push(n.value);
    }
    if (hits.length > 0) {
      const handle = String(o.username ?? o.handle ?? o.query ?? "").trim();
      const unverifiedList = Array.isArray(o.unverified) ? o.unverified : [];
      const unverifiedCount = unverifiedList.length;
      // The NAMES of the undetermined platforms, not just how many. A sweep that
      // reaches a site and cannot prove the account either way is the single most
      // decision-relevant thing the sweep produces, because the platforms that
      // block datacenter egress (Instagram, TikTok, X…) are exactly the ones an
      // investigation cares about — and they are indistinguishable from "absent"
      // once the count is all that survives. Live case (glitterkittens12,
      // 2026-09-08): the sweep resolved 109 sites, proved 65 absent and could not
      // decide 40 — Instagram among them. The analyst was shown "4 platform
      // registrations" and nothing else, so a 29k-follower VERIFIED Instagram
      // account that the seed was literally named after read as "not found", and
      // the run looked like the sweep had never executed.
      const unverifiedSites = unverifiedList
        .map((u) => (u && typeof u === "object" ? String((u as Record<string, unknown>).site ?? "") : ""))
        .filter(Boolean)
        .slice(0, 60);
      if (SWEEP_COLLAPSE_ENABLED && handle && hits.length >= SWEEP_COLLAPSE_MIN_HITS) {
        findings.push({
          kind: "social_footprint",
          // The headline still counts ONLY proven registrations — an undetermined
          // site is never absorbed into the hit count (that is the rule the
          // `unverified` split exists to enforce). It is disclosed alongside it,
          // in the one field the analyst actually reads: the artifact value.
          value: `${handle} — ${hits.length} platform registration${hits.length === 1 ? "" : "s"}` +
            (unverifiedCount > 0 ? `, ${unverifiedCount} undetermined (reachable, unproven)` : ""),
          context: {
            tool: toolName,
            via: "username_sweep",
            handle,
            platform_count: hits.length,
            // Every URL is preserved here — collapsing the ARTIFACT must not lose
            // the underlying data, only stop it inflating the evidence count.
            urls: hits,
            // Reachable but unevidenced pages are DISCLOSED, not counted: the
            // headline number must never absorb a soft-404.
            ...(unverifiedCount > 0
              ? {
                unverified_platform_count: unverifiedCount,
                unverified_platforms: unverifiedSites,
              }
              : {}),
          },
          rawConfidence: 30,
        });
      } else {
        // Below the collapse threshold (or no handle to group under): a couple of
        // hits are legible on their own and worth surfacing individually.
        for (const u of hits) pushUrl(findings, u, { tool: toolName, via: "username_sweep" });
      }
    }
  }

  // 12b) opsis_search / opsis_results (lib/opsis.ts) — third-party account
  //      enumeration across ~700 platforms. Treated exactly like a sweep, because
  //      it IS one: a hit says a string is registered somewhere, nothing about who
  //      owns it. Same collapse rule, same raw confidence, no new source class.
  //
  //      Deliberate choices, each an integrity decision rather than a style one:
  //      - ONLY a completed run persists. A partial run's hits reach the model in
  //        the tool result, and the run is finished with opsis_results; persisting
  //        both would put two footprint rows on one selector.
  //      - Opsis's own 0–1 `opsis_confidence` and its `module` are NOT carried
  //        into confidence or into metadata.source — they are a vendor's module
  //        score, not our evidence grade.
  //      - Platform names go under `opsis_platforms`, never `platform`: metadata
  //        `platform` is scanned for breach vocabulary (`last.fm` matches).
  if ((toolName === "opsis_search" || toolName === "opsis_results") &&
      o.source === "opsis" && o.complete === true && Array.isArray(o.results)) {
    const rows = (o.results as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
    const queried = String(o.value ?? "").trim();
    const kind = String(o.kind ?? "").trim();
    const urls: string[] = [];
    const platforms: string[] = [];
    for (const r of rows) {
      const n = normalizeFinding("url", r.value);
      if (n && !urls.includes(n.value)) urls.push(n.value);
      const p = typeof r.platform === "string" ? r.platform.trim() : "";
      if (p && !platforms.includes(p)) platforms.push(p);
    }
    // The headline counts what Opsis FOUND; `results` is capped at
    // OPSIS_MAX_RESULTS_RETURNED for the prompt (Codex P2 on #659).
    const total = typeof o.total_results === "number" && o.total_results >= rows.length ? o.total_results : rows.length;
    if (queried && rows.length >= SWEEP_COLLAPSE_MIN_HITS) {
      findings.push({
        kind: "social_footprint",
        value: `${queried} — ${total} Opsis result${total === 1 ? "" : "s"} (unverified)`,
        context: {
          tool: toolName,
          via: "opsis",
          ...(kind === "username" ? { handle: queried } : {}),
          opsis_kind: kind,
          opsis_run_id: typeof o.run_id === "string" ? o.run_id : null,
          platform_count: total,
          urls,
          opsis_platforms: platforms,
          ...(typeof o.results_truncated === "number" ? { opsis_results_truncated: o.results_truncated } : {}),
        },
        rawConfidence: 30,
      });
    } else {
      for (const u of urls) pushUrl(findings, u, { tool: toolName, via: "opsis" });
    }
  }

  // 13) INFRASTRUCTURE payloads — the shapes a DOMAIN investigation actually returns.
  //
  // Every branch above targets a PERSON shape: breach corpora, emails, usernames,
  // social and github profiles. None matches an infra payload, so a domain seed
  // persisted almost nothing. Measured on thread dd2514e3 (build 6210ef9): 33 tool
  // calls, 21 of them ok, FOUR artifacts — and the only ones that landed came from
  // crtsh_subdomains, which survived by accident because it happens to emit the
  // `{ subdomains: [] }` shape branch 7 already matched. whois, dns, shodan,
  // ip_intel×2, urlscan, virustotal and oathnet_subdomains all returned ok and were
  // all discarded. Person-seeded runs land at 29–142 artifacts; that one got 4.
  //
  // Scope is deliberately narrow: ONLY kinds ALLOWED_KINDS already admits
  // (domain / ip_address / organization). Ports, CPEs, vulns and reputation
  // verdicts are attributes of a host, not entities about the subject, and are
  // NOT persisted — inflating the evidence board is the failure this codebase
  // keeps having to undo.
  const infraDomain = (raw: unknown, via: string) => {
    if (typeof raw !== "string") return;
    // An MX answer is "<priority> <host>"; every DoH answer is fully qualified with
    // a TRAILING DOT, which normalizeFinding's domain regex rejects outright. Both
    // must be stripped or the value is silently dropped.
    const host = raw.trim().split(/\s+/).pop()?.replace(/\.$/, "") ?? "";
    if (host) push("domain", host, { via }, 40);
  };
  const infraIp = (raw: unknown, via: string) => {
    if (typeof raw === "string" && raw.trim()) push("ip_address", raw.trim(), { via }, 40);
  };
  const dataObj = o.data && typeof o.data === "object" ? o.data as Record<string, unknown> : null;

  // dns_records → { host, records: { A|AAAA|NS|MX|CNAME: [{ data }] } } (Cloudflare DoH)
  // Tool-gated for the same reason as ip_intel below: `records` is a generic key
  // (GLEIF returns a top-level `records` ARRAY), and relying on Array.isArray to
  // skip it is implicit safety that breaks silently when a shape changes.
  const dnsRecords = toolName === "dns_records" && o.records && typeof o.records === "object"
    ? o.records as Record<string, unknown>
    : null;
  if (dnsRecords) {
    for (const [type, answers] of Object.entries(dnsRecords)) {
      if (!Array.isArray(answers)) continue;
      for (const a of answers.slice(0, MAX_AUTO_PERSIST_PER_TOOL_CALL)) {
        const d = typeof a === "string" ? a : (a as { data?: unknown })?.data;
        if (type === "A" || type === "AAAA") infraIp(d, `dns:${type}`);
        else if (type === "NS" || type === "MX" || type === "CNAME") infraDomain(d, `dns:${type}`);
      }
    }
  }

  // ip_intel → ip-api fields spread at the top level. Tool-gated: a bare `query`
  // key is far too generic to match on shape without catching other tools.
  if (toolName === "ip_intel") {
    const locationKind = typeof o.location_kind === "string" ? o.location_kind : undefined;
    infraIp(o.query, "ip_intel");
    // The network OPERATOR is not the subject's organization. ip_intel already
    // tells us when it is merely infrastructure — `{ cdn: true, cdn_provider,
    // location_kind: "cdn_edge" }`, plus ip-api's own `hosting` / `proxy` flags —
    // and its own note says the geo "reflects CDN POP, not the actual origin
    // server". Persisting `org` regardless writes "Cloudflare, Inc." as an
    // organization about the SUBJECT, and graph.ts promotes an `organization`
    // artifact to an entity node in the link-analysis graph. For any CDN-fronted
    // domain — the common case — that is an invented affiliation.
    //
    // Same trade the name normalizer already codifies: a false negative loses one
    // weak artifact, a false positive invents a relationship. Take the loss.
    const isInfrastructureOnly = o.cdn === true || o.hosting === true || o.proxy === true ||
      locationKind === "cdn_edge";
    const owner = typeof o.org === "string" && o.org.trim() ? o.org : o.isp;
    if (!isInfrastructureOnly && typeof owner === "string" && owner.trim()) {
      // Provenance travels with the row so downstream can still discount it.
      push("organization", owner, { via: "ip_intel", location_kind: locationKind }, 35);
    }
  }

  // whois_lookup → rdap.org, which returns RFC 7483 RDAP: a STANDARD schema, so
  // `nameservers[].ldhName` is knowable rather than provider-specific. Registrant
  // identity is deliberately NOT extracted: it is usually GDPR-redacted, and
  // parsing vCards to name an owner is the CDN mistake in a more damaging form.
  if (toolName === "whois_lookup" && dataObj && Array.isArray(dataObj.nameservers)) {
    for (const ns of dataObj.nameservers.slice(0, MAX_AUTO_PERSIST_PER_TOOL_CALL)) {
      const host = typeof ns === "string" ? ns : (ns as { ldhName?: unknown })?.ldhName;
      // RDAP returns names uppercased; normalizeFinding lowercases for `domain`.
      infraDomain(host, "whois:rdap");
    }
  }

  // shodan_internetdb → { data: { ip, hostnames[] } }
  if (toolName === "shodan_internetdb" && dataObj) {
    infraIp(dataObj.ip, "shodan");
    if (Array.isArray(dataObj.hostnames)) {
      for (const h of dataObj.hostnames.slice(0, MAX_AUTO_PERSIST_PER_TOOL_CALL)) infraDomain(h, "shodan");
    }
  }

  // NOTE — there is deliberately NO `data.subdomains` branch. Every subdomain
  // producer emits the list at the TOP level, where branch 7 already reads it:
  // crtsh_subdomains, crtsh_lookup, and oathnet_subdomains (which unwraps its
  // provider's nested payload internally and re-emits flat). A nested branch
  // matched no tool in this repo. That also means oathnet_subdomains hits were
  // ALREADY covered — so its zero yield in thread dd2514e3 is still undiagnosed;
  // check the raw output for the missing-key bail or the quota skipStub before
  // treating that particular gap as closed.

  // ---- Collapse breach corpus names into ONE exposure artifact per provider --
  // Mirrors the username_sweep collapse directly above: the ARTIFACT count drops,
  // the underlying data does not. Every corpus name is retained in
  // metadata.breach_corpora, sorted for determinism, with an explicit truncation
  // disclosure if a provider ever exceeds the retention bound.
  //
  // These are UNSHIFTED to the front on purpose. The de-dup loop below stops at
  // MAX_AUTO_PERSIST_PER_TOOL_CALL, and a row that stands in for 47 corpora must
  // never be the one evicted by that cap.
  // The subject this call was queried on. Scoping the VALUE (not just metadata)
  // is load-bearing: the dedup key is checkpointKey(kind, value), thread-wide via
  // loadSeenArtifactKeys. A subject-agnostic `Breach exposure (rapidapi)` collides
  // across subjects, so a SECOND selector's exposure in the same thread was
  // silently dropped as a duplicate. Anchoring the value on the queried selector
  // gives each subject its own row.
  const subjectLabel = breachSubjectAnchor(o, input);
  const exposures: ExtractedFinding[] = [];
  for (const [via, set] of breachCorpora) {
    const corpora = [...set].sort();
    if (corpora.length === 0) continue;
    const kept = corpora.slice(0, MAX_BREACH_CORPORA_PER_EXPOSURE);
    exposures.push({
      kind: "breach_exposure",
      value: subjectLabel
        ? `Breach exposure: ${subjectLabel} (${via})`
        : `Breach exposure (${via})`,
      context: {
        tool: toolName,
        via,
        // Provenance + the seed of selector-keyed aggregation. Null when the
        // selector could not be determined (the value stays subject-agnostic).
        queried_selector: subjectLabel || null,
        breach_corpora: kept,
        breach_corpus_count: corpora.length,
        ...(corpora.length > kept.length
          ? { breach_corpora_truncated: true, breach_corpora_retained: kept.length }
          : {}),
      },
      // Unchanged from the per-corpus rows this replaces. This is a SHAPE change,
      // not a scoring change: no confidence value moves, no cap is touched, and
      // applyEvidenceCaps still runs downstream exactly as before.
      rawConfidence: 55,
    });
  }
  findings.unshift(...exposures);

  // QUARANTINE STAMP — applied here, after every branch has emitted, so it cannot
  // be missed by a provider branch that pushes through pushUrl or the collapsed
  // breach path rather than `push`. A name-only query proves nothing about WHO a
  // returned row belongs to, so each one is disclosed as an unlinked lead.
  if (nameOnly) {
    for (const f of findings) {
      // The query echoed back — a `name` row equal to what was asked. This is the
      // subject's own asserted name ONLY when the queried name was linked to the
      // subject in the first place. When the queried name was harvested mid-run,
      // the echo belongs to whoever the provider matched on that name — a
      // same-name stranger in the failure case — so it is quarantined like every
      // other row here, under its own reason. Name equality is not linkage.
      if (f.kind === "name" && normalizeBreachSubject(f.value) === queriedName) {
        if (queriedNameIsSubjectLinked) continue;
        f.context = { ...(f.context ?? {}), ...UNLINKED_ECHO_CTX };
        continue;
      }
      f.context = { ...(f.context ?? {}), ...SUBJECT_UNLINKED_CTX };
    }
  }

  // DERIVED-LINKAGE STAMP — the promotion-quarantine invariant.
  //
  // The stamp above keys on QUERY SHAPE, which is why it is not enough on its
  // own any more. Since 2026-09-12 a quarantined selector may be dispatched
  // (lib/unproven-linkage.ts), and `username_sweep` on a harvested username is
  // not a name-only query — so without this, a stranger's profiles would
  // persist at FULL subject authority, join identity clusters and reach the
  // report. That is the hole #433 closed, re-opened from a different direction.
  //
  // Authority is not inherited: a lookup whose parent selector has unproven
  // linkage yields findings with unproven linkage. Runs LAST so a row already
  // carrying a more specific reason (name-only echo, bulk corpus) keeps it.
  const derivedParent = unprovenLinkageFromOutput(output);
  if (derivedParent) {
    const derivedCtx = derivedUnlinkedContext(derivedParent);
    for (const f of findings) {
      if ((f.context as Record<string, unknown> | undefined)?.subject_unlinked === true) {
        // Already quarantined under a more specific reason — record the parent
        // for release/audit, but do not overwrite why it was quarantined.
        f.context = { ...(f.context ?? {}), unproven_linkage_parent: derivedCtx.unproven_linkage_parent };
        continue;
      }
      f.context = { ...(f.context ?? {}), ...derivedCtx };
    }
  }

  // CORPUS STAMP — cardinality, not content. Runs AFTER the name-only stamp so a
  // row already quarantined there keeps its more specific reason, and BEFORE the
  // de-dup so every emitted row is covered whichever branch pushed it.
  //
  // Note what is deliberately NOT stamped: the `breach_exposure` summary row
  // naming the corpus ("psyber.com domain breach: 45+ records across 18+ breach
  // DBs"). That row is evidence ABOUT the thing that was queried and keeps full
  // authority. Only its members lose it — which is exactly the finding: the
  // dataset is real, the strangers inside it are not the subject.
  {
    const bulk = findings.filter((f) =>
      CORPUS_IDENTITY_KINDS.has(f.kind) &&
      (f.context as Record<string, unknown> | undefined)?.subject_unlinked !== true
    );
    if (bulk.length > BULK_HARVEST_IDENTITY_CAP) {
      const ctx = coCorpusCtx(bulk.length);
      const queried = queriedSelectorRaw(input);
      for (const f of bulk) {
        if (echoesQueriedSelector(f.value, queried, subjectSeedName ?? "")) continue;
        f.context = { ...(f.context ?? {}), ...ctx };
      }
    }
  }

  // HARVEST COLLAPSE — one summary row, not 67 identical quarantine cards.
  // Mirrors username_sweep / breach_exposure collapse: the ARTIFACT count drops,
  // every harvested identity is retained in metadata.harvested_identities.
  //
  // TWO classes collapse here, and they are different findings:
  //   - BULK CORPUS: one selector returned a dataset of many people. The dataset
  //     itself is real evidence; its members are strangers.
  //   - NAME-ONLY HARVEST: one name returned everyone who shares that name.
  //     Nothing here is evidence — name equality is not linkage.
  //
  // The second class used to be UNCOLLAPSIBLE, which is the defect this fixes.
  // The name-only gate above stamps subject_unlinked on EVERY row it emits; the
  // corpus stamp then skips rows already carrying subject_unlinked, so `bulk` came
  // back empty and nothing collapsed. Measured in production 2026-09-03 on thread
  // `c599a5bc`: two `oathnet_lookup{type:"name"}` calls persisted 42 separate
  // quarantine cards (15 addresses, 14 phones, 12 emails, 1 name) out of 123
  // artifacts on the thread. The two mechanisms have to compose, not exclude.
  if (BULK_CORPUS_COLLAPSE_ENABLED) {
    const queried = queriedSelectorRaw(input);
    const anchor = breachSubjectAnchor(o, input) || queried || "";

    // Classify once. A row collapses only if it is a corpus-identity kind, carries
    // one of the two harvest stamps, and is NOT the echo of the queried selector.
    const bulkRows: ExtractedFinding[] = [];
    const nameRows: ExtractedFinding[] = [];
    for (const f of findings) {
      if (!CORPUS_IDENTITY_KINDS.has(f.kind)) continue;
      const ctx = f.context as Record<string, unknown> | undefined;
      const isBulk = isBulkCorpusQuarantine(ctx);
      const isNameOnly = !isBulk && isNameOnlyHarvestQuarantine(ctx);
      if (!isBulk && !isNameOnly) continue;
      if (echoesQueriedSelector(f.value, queried, subjectSeedName ?? "")) continue;
      (isBulk ? bulkRows : nameRows).push(f);
    }

    // The bulk stamp is only ever applied past BULK_HARVEST_IDENTITY_CAP, so its
    // presence already means "this was a corpus" — any number collapses. The
    // name-only stamp is applied to every row of a name lookup regardless of
    // count, so it needs its own floor or a two-row return would collapse too.
    const collapseBulk = bulkRows.length > 0;
    const collapseName = nameRows.length > NAME_ONLY_HARVEST_COLLAPSE_CAP;

    if (collapseBulk || collapseName) {
      const buildSummary = (rows: ExtractedFinding[], cls: "bulk" | "name"): ExtractedFinding => {
        const harvested = rows.map((f) => ({ kind: f.kind, value: f.value }));
        const retained = harvested.slice(0, MAX_BULK_CORPUS_ITEMS_RETAINED);
        const rowCount = rows.length;
        // Parse the cardinality from the shared reason when present — it names the
        // full lookup yield, which can exceed what survived the per-call cap.
        const parsedTotal = Number(
          String(rows[0]?.context?.subject_unlinked_reason ?? "").match(/(\d+) person identities/)?.[1] ?? "",
        );
        const lookupYield = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : rowCount;
        return {
          kind: "bulk_corpus_harvest",
          value: cls === "bulk"
            ? (anchor
              ? `${lookupYield} unlinked identities — bulk corpus (${anchor})`
              : `${lookupYield} unlinked identities — bulk corpus return`)
            : (anchor
              ? `${rowCount} same-name identities — name-only collision (${anchor})`
              : `${rowCount} same-name identities — name-only collision`),
          context: {
            tool: toolName,
            via: toolName,
            ...(cls === "bulk" ? { bulk_corpus: true } : { name_only_harvest: true }),
            identity_count: cls === "bulk" ? lookupYield : rowCount,
            collapsed_row_count: rowCount,
            queried_selector: anchor || queried || null,
            harvested_identities: retained,
            ...(harvested.length > retained.length
              ? { harvested_truncated: true, harvested_retained: retained.length }
              : {}),
            ...(cls === "bulk" ? coCorpusCtx(lookupYield) : nameCollisionCtx(rowCount)),
          },
          rawConfidence: 40,
        };
      };

      const drop = new Set<ExtractedFinding>();
      if (collapseBulk) for (const f of bulkRows) drop.add(f);
      if (collapseName) for (const f of nameRows) drop.add(f);
      const kept = findings.filter((f) => !drop.has(f));

      const summaries: ExtractedFinding[] = [];
      if (collapseBulk) summaries.push(buildSummary(bulkRows, "bulk"));
      if (collapseName) summaries.push(buildSummary(nameRows, "name"));

      // Insert AFTER breach_exposure rows — those are unshifted to the front on
      // purpose and must never lose priority to a harvest summary.
      const insertAt = kept.findIndex((f) => f.kind !== "breach_exposure");
      if (insertAt === -1) kept.push(...summaries);
      else kept.splice(insertAt, 0, ...summaries);
      findings.length = 0;
      findings.push(...kept);
    }
  }

  // De-dup within this extraction.
  const seen = new Set<string>();
  const uniq: ExtractedFinding[] = [];
  const breachGuard = !breachExposureGuardDisabled();
  for (const f of findings) {
    // A breach_exposure finding is kept only from a breach-capable tool (lib/breach-exposure-guard.ts).
    if (breachGuard && BREACH_EXPOSURE_KINDS.has(f.kind) && !isBreachCapableTool(toolName)) continue;
    const k = checkpointKey(f.kind, f.value);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(f);
    if (uniq.length >= MAX_AUTO_PERSIST_PER_TOOL_CALL) break;
  }
  return uniq;
}

/** Walk every tool result on a step. Returns a de-duped, step-capped list.
 *
 *  `subjectSeedName` is threaded through to extractFindings unchanged — see there
 *  for why it is the only thing that can keep a queried-name echo authoritative.
 *  Omitted (the unit-test call shape) fails closed. */
export function extractStepFindings(
  toolResults: unknown[] | null | undefined,
  subjectSeedName?: string,
  /** Zero-evidence escalation — see ESCALATION_ELIGIBLE_TOOLS. Default off, so
   *  every existing caller and test keeps today's exact behaviour. */
  opts?: { escalated?: boolean },
): Array<ExtractedFinding & { toolName: string }> {
  if (!Array.isArray(toolResults)) return [];
  const out: Array<ExtractedFinding & { toolName: string }> = [];
  const seen = new Set<string>();
  for (const tr of toolResults) {
    const t = tr as { toolName?: unknown; output?: unknown; result?: unknown };
    const name = typeof t?.toolName === "string" ? t.toolName : "";
    if (!name) continue;
    const output = (t.output ?? t.result) ?? null;
    // The AI SDK step envelope carries the tool-call arguments; thread them so a
    // breach exposure is scoped to the subject that was queried (P0: subject
    // collision). `args`/`parameters` cover older/alternate envelope shapes.
    const te = t as { input?: unknown; args?: unknown; parameters?: unknown };
    const input = te.input ?? te.args ?? te.parameters ?? null;
    const findings = extractFindings(name, output, input, subjectSeedName, opts);
    for (const f of findings) {
      const k = checkpointKey(f.kind, f.value);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...f, toolName: name });
      if (out.length >= MAX_AUTO_PERSIST_PER_STEP) return out;
    }
  }
  return out;
}

type SupabaseInsertLike = {
  from: (table: string) => {
    insert: (rows: Array<Record<string, unknown>>) => Promise<{ error: { message: string } | null; data?: unknown }>;
  };
  /** Present on the real client; optional so existing fixtures keep working and a
   *  client without it degrades to "artifact written, no ledger entry" rather than
   *  throwing inside the detached backstop. */
  rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
};

/**
 * Auto-recorded rows enter the ledger as SOFT, always — never derived from
 * confidence the way record_artifacts derives it (>= 85 → "hard").
 *
 * THIS IS THE INTEGRITY CRUX of putting the backstop on the chain. A row here was
 * extracted from tool output by a regex-grade extractor with no model or analyst
 * judgement applied. Giving it a chain entry must make it AUDITABLE, never
 * VERIFIED. If classification were derived from confidence, a high-confidence
 * extraction would enter the tamper-evident log indistinguishable from a
 * model-reviewed finding — laundering extractor output into hard evidence, which
 * is precisely the failure the chain exists to prevent.
 */
export const AUTO_EVIDENCE_CLASSIFICATION = "soft";

/** Bounded retries for the seq race described in appendAutoEvidence. */
export const AUTO_EVIDENCE_MAX_RETRIES = 2;

/** A unique-violation on evidence_log(thread_id, seq) — i.e. we lost the seq race. */
function isSeqRace(message: string): boolean {
  const m = (message ?? "").toLowerCase();
  return m.includes("duplicate key") || m.includes("unique constraint") || m.includes("evidence_log_thread_id_seq_key");
}

/**
 * Append one chain-of-custody row per auto-recorded artifact.
 *
 * WHY (production 2026-08-06): this module wrote `public.artifacts` and nothing
 * else, so every finding it rescued existed with NO entry in `evidence_log`. On
 * thread f9056822 the model called record_artifacts zero times across 28 tool
 * calls, so the backstop wrote everything and the run closed with 4 artifacts
 * behind 2 chain entries. Across the last 8 threads, 6 held more artifacts than
 * chain entries — inverting the documented invariant that the chain is the larger
 * count. Evidence the analyst can see but cannot audit is the problem being fixed.
 *
 * Contract, and why each part is the way it is:
 *   - SERIAL, never Promise.all. `append_evidence` computes seq as
 *     MAX(seq)+1 per thread with no lock, so parallel appends collide by design.
 *   - Races are SAFE, not corrupting: evidence_log has a UNIQUE(thread_id, seq)
 *     index, so a lost race is a failed INSERT, never a forked chain. We retry
 *     (the RPC recomputes MAX(seq) each call) rather than drop the row — this
 *     module now writes concurrently with record_artifacts, which is exactly when
 *     the race can happen.
 *   - Uses the USER-SCOPED client. `append_evidence` is SECURITY DEFINER over
 *     auth.uid() and rejects a thread the caller does not own, so a service-role
 *     client would raise "must be authenticated".
 *   - NEVER throws. The caller is a detached, best-effort backstop; a ledger
 *     failure must degrade to "artifact without chain entry" (which the workspace
 *     header now surfaces as "N recorded · M chain-verified"), never break a run.
 *
 * @returns how many chain entries were appended.
 */
export async function appendAutoEvidence(
  ctx: AutoPersistContext,
  rows: Array<Record<string, unknown>>,
): Promise<number> {
  const rpc = ctx.supabase.rpc;
  if (typeof rpc !== "function" || !Array.isArray(rows) || rows.length === 0) return 0;
  let appended = 0;
  for (const r of rows) {
    const meta = (r.metadata as Record<string, unknown> | null) ?? {};
    const rawUrl = meta.source_url ?? meta.url ?? meta.profile_url ?? meta.archived_url ?? null;
    const args = {
      _thread_id: ctx.threadId,
      _artifact_id: null,
      _tool_name: typeof r.source === "string" ? r.source : "auto_persist",
      _source: typeof r.source === "string" ? r.source : null,
      _source_url: typeof rawUrl === "string" ? rawUrl : null,
      // Never confidence-derived — see AUTO_EVIDENCE_CLASSIFICATION.
      _classification: AUTO_EVIDENCE_CLASSIFICATION,
      _confidence: typeof r.confidence === "number" ? r.confidence : null,
      _kind: String(r.kind ?? ""),
      _value: String(r.value ?? ""),
      _content_snapshot: JSON.stringify(meta).slice(0, 1500),
      // `auto_recorded: true` rides along from buildAutoRecordedRow; it is what
      // keeps a machine-extracted ledger row distinguishable from a reviewed one.
      _metadata: meta,
    };
    for (let attempt = 0; attempt <= AUTO_EVIDENCE_MAX_RETRIES; attempt++) {
      try {
        const { error } = await rpc.call(ctx.supabase, "append_evidence", args);
        if (!error) { appended++; break; }
        if (!isSeqRace(error.message) || attempt === AUTO_EVIDENCE_MAX_RETRIES) {
          console.warn("[auto-persist-findings] append_evidence:", error.message);
          break;
        }
      } catch (e) {
        console.warn("[auto-persist-findings] append_evidence threw:", (e as Error)?.message ?? e);
        break;
      }
    }
  }
  return appended;
}

export type AutoPersistContext = {
  supabase: SupabaseInsertLike;
  threadId: string;
  userId: string;
  /** Caller-owned dedup set (same one used by incremental-persist checkpoints)
   *  so a value auto-recorded here also blocks the checkpoint from re-listing
   *  it, and vice versa. Seeded from prior checkpoints + prior artifacts. */
  seen: Set<string>;
};

export type AutoPersistResult = {
  inserted: number;
  skipped_duplicates: number;
  rows: Array<Record<string, unknown>>;
  /** Chain-of-custody rows appended for those inserts (see appendAutoEvidence).
   *  Less than `inserted` means artifacts landed without a ledger entry. */
  evidence_appended?: number;
};

/**
 * Convert extracted findings into scrubbed artifact rows and insert them.
 * Never throws — an auto-persist failure must NEVER break the run.
 */
export async function persistAutoFindings(
  ctx: AutoPersistContext,
  findings: Array<ExtractedFinding & { toolName: string }>,
): Promise<AutoPersistResult> {
  if (!Array.isArray(findings) || findings.length === 0) return { inserted: 0, skipped_duplicates: 0, rows: [] };

  const fresh: Array<ExtractedFinding & { toolName: string }> = [];
  let dups = 0;
  for (const f of findings) {
    const k = checkpointKey(f.kind, f.value);
    if (ctx.seen.has(k)) { dups++; continue; }
    fresh.push(f);
  }
  if (fresh.length === 0) return { inserted: 0, skipped_duplicates: dups, rows: [] };

  const rows = fresh.map((f) => {
    const built = buildAutoRecordedRow({
      kind: f.kind,
      value: f.value,
      source: f.toolName,
      rawConfidence: f.rawConfidence ?? 30,
      metadata: {
        auto_persist_source: "tool_return_extractor",
        ...(f.context ?? {}),
      },
    });
    return { thread_id: ctx.threadId, user_id: ctx.userId, ...built };
  });

  const safeRows = scrubArtifactRows(rows);
  if (safeRows.length === 0) return { inserted: 0, skipped_duplicates: dups, rows: [] };

  try {
    const { error } = await ctx.supabase.from("artifacts").insert(safeRows);
    if (error) {
      console.warn("[auto-persist-findings] insert failed:", error.message);
      return { inserted: 0, skipped_duplicates: dups, rows: [] };
    }
  } catch (e) {
    console.warn("[auto-persist-findings] insert threw:", (e as Error)?.message ?? e);
    return { inserted: 0, skipped_duplicates: dups, rows: [] };
  }

  // Mark as seen so subsequent checkpoints don't re-announce and future steps
  // don't re-insert.
  for (const f of fresh) ctx.seen.add(checkpointKey(f.kind, f.value));

  // Chain of custody for the rows we just inserted — ONLY those. Duplicates that
  // were skipped above already have their ledger entry from the pass that first
  // wrote them, so appending again would add a second chain row for one finding.
  // Best-effort by contract: a ledger failure leaves the artifacts in place.
  const evidence_appended = await appendAutoEvidence(ctx, safeRows);

  return { inserted: safeRows.length, skipped_duplicates: dups, rows: safeRows, evidence_appended };
}

/**
 * Seed the dedup set from artifacts already persisted for this thread, so a
 * re-run / recovery never re-inserts an existing (kind,value). Best-effort.
 */
export async function loadSeenArtifactKeys(
  supabase: {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, v: unknown) => {
          range: (from: number, to: number) => Promise<{ data: Array<{ kind?: unknown; value?: unknown }> | null; error: unknown }>;
        };
      };
    };
  },
  threadId: string,
): Promise<Set<string>> {
  const seen = new Set<string>();
  try {
    // PAGED (2026-08-28). This was one unbounded `.select().eq()`, so on a thread
    // past PostgREST's server-side row cap the dedup set was silently truncated
    // and the rows beyond it could be written a second time. Same shape as the
    // recovery incident `recovery_artifact_paging_test.ts` pins: a single
    // `.limit()` read the first 40 of 85 artifacts and closed a run on a minority
    // of its own evidence. Read and render are different questions.
    for (let from = 0; from < SEEN_ARTIFACT_SCAN_MAX; from += SEEN_ARTIFACT_PAGE_SIZE) {
      const to = Math.min(from + SEEN_ARTIFACT_PAGE_SIZE, SEEN_ARTIFACT_SCAN_MAX) - 1;
      const { data, error } = await supabase.from("artifacts").select("kind,value").eq("thread_id", threadId).range(from, to);
      // Best-effort by contract: a partial set means a duplicate may slip
      // through, which is today's behaviour. It can never cause over-collapsing.
      if (error || !Array.isArray(data)) break;
      for (const r of data) {
        const k = typeof r?.kind === "string" ? r.kind : "";
        const v = typeof r?.value === "string" ? r.value : "";
        if (!k || !v) continue;
        seen.add(checkpointKey(k, v));
        // MIGRATION-FREE RECONCILIATION. Rows written before the canonical phone
        // fold hold "9175550123" where a new extraction now yields
        // "+19175550123" — different keys for one number, so the legacy row
        // would not block the re-insert. Registering the normalized spelling too
        // makes old and new rows agree without touching a single stored row.
        const n = normalizeFinding(k, v);
        if (n && n.value !== v) seen.add(checkpointKey(n.kind, n.value));
      }
      if (data.length < SEEN_ARTIFACT_PAGE_SIZE) break;
      // DISCLOSE the ceiling. `loadThreadArtifactIdentities` surfaces
      // `thread_dedup_partial` when it stops early; this path returns a bare Set
      // with nowhere to put that, so it said nothing at all — a dedup gate that
      // quietly stops deduping, which is the exact thing the other path's
      // comment argues against. Logged rather than silent until there is a
      // channel to carry it.
      if (from + SEEN_ARTIFACT_PAGE_SIZE >= SEEN_ARTIFACT_SCAN_MAX) {
        console.warn(JSON.stringify({
          event: "seen_artifact_scan_truncated",
          thread_id: threadId,
          scanned: SEEN_ARTIFACT_SCAN_MAX,
          note: "thread exceeds the dedup scan ceiling — rows beyond it can be re-inserted",
        }));
      }
    }
  } catch (e) {
    console.warn("[auto-persist-findings] loadSeenArtifactKeys failed:", (e as Error)?.message ?? e);
  }
  return seen;
}
