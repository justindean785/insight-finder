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

import { buildAutoRecordedRow } from "./auto-record-integrity.ts";
import { scrubArtifactRows } from "./safety.ts";
import { checkpointKey } from "./incremental-persist.ts";

/** Hard ceiling on auto-persisted rows PER tool call. Prevents one exhaustive
 *  scrape (Wayback captures, GitHub search hits) from writing hundreds of rows. */
export const MAX_AUTO_PERSIST_PER_TOOL_CALL = 25;

/** Corpus names retained inside a single breach_exposure artifact. Far above the
 *  worst case observed in production (88 corpora in one thread), so truncation is
 *  a disclosed edge case rather than routine lossiness. */
export const MAX_BREACH_CORPORA_PER_EXPOSURE = 250;
/** Hard ceiling on auto-persisted rows PER step across all tool calls. */
export const MAX_AUTO_PERSIST_PER_STEP = 60;

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
  // Attribution / integrity guards — no user-facing findings.
  "attribution_check", "date_sanity_check",
]);

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
      return { kind: "phone", value: digits };
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

/** Extract findings from a single tool call's parsed output. Never throws. */
export function extractFindings(toolName: string, output: unknown): ExtractedFinding[] {
  if (AUTO_PERSIST_TOOL_DENYLIST.has(toolName)) return [];
  if (!output || typeof output !== "object") return [];
  const o = output as Record<string, unknown>;
  // Never extract from an explicit tool error.
  if (o.ok === false || typeof o.error === "string") return [];

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

  // 9) serus_darkweb_scan — extractedData holds the PARSED leak fields (never
  //    passwords/hashes); breaches[] the breach names.
  if (toolName === "serus_darkweb_scan") {
    const ed = o.extractedData as Record<string, unknown> | null;
    if (ed && typeof ed === "object") {
      if (Array.isArray(ed.emails)) for (const e of ed.emails) push("email", e, { via: "serus" }, 45);
      if (Array.isArray(ed.phones)) for (const p of ed.phones) push("phone", String(p ?? ""), { via: "serus" }, 45);
      if (Array.isArray(ed.names)) for (const n of ed.names) push("name", n, { via: "serus" }, 40);
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
      for (const it of items.slice(0, MAX_AUTO_PERSIST_PER_TOOL_CALL)) {
        if (!it || typeof it !== "object") continue;
        const row = it as Record<string, unknown>;
        push("email", row.email, { via: "oathnet" }, 45);
        const phoneRaw = row.phone_number ?? row.phone_national ?? row.phone_number2;
        if (phoneRaw != null) push("phone", String(phoneRaw), { via: "oathnet" }, 45);
        const fullName = row.full_name ?? row.display_name
          ?? [row.first_name, row.middle_name, row.last_name].filter((x) => typeof x === "string" && x).join(" ");
        push("name", fullName, { via: "oathnet" }, 40);
        push("username", row.username, { via: "oathnet" }, 45);
        push("ip_address", row.ip, { via: "oathnet" }, 40);
        if (typeof row.linkedin === "string") pushUrl(findings, row.linkedin, { tool: toolName, via: "oathnet_linkedin" });
        const addr = [row.address_street, row.address_street2, row.address_city ?? row.city,
          row.address_state ?? row.state, row.address_postcode ?? row.postal_code ?? row.zip]
          .filter((x) => typeof x === "string" && x).join(" ");
        push("address", addr, { via: "oathnet" }, 45);
      }
    }
  }

  // 12) username_sweep — found[] are CONFIRMED profile hits (status 2xx). The
  //     profile URL is the finding; it lives in `found`, not items/results/matches,
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
      if (SWEEP_COLLAPSE_ENABLED && handle && hits.length >= SWEEP_COLLAPSE_MIN_HITS) {
        findings.push({
          kind: "social_footprint",
          value: `${handle} — ${hits.length} platform registration${hits.length === 1 ? "" : "s"}`,
          context: {
            tool: toolName,
            via: "username_sweep",
            handle,
            platform_count: hits.length,
            // Every URL is preserved here — collapsing the ARTIFACT must not lose
            // the underlying data, only stop it inflating the evidence count.
            urls: hits,
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

  // ---- Collapse breach corpus names into ONE exposure artifact per provider --
  // Mirrors the username_sweep collapse directly above: the ARTIFACT count drops,
  // the underlying data does not. Every corpus name is retained in
  // metadata.breach_corpora, sorted for determinism, with an explicit truncation
  // disclosure if a provider ever exceeds the retention bound.
  //
  // These are UNSHIFTED to the front on purpose. The de-dup loop below stops at
  // MAX_AUTO_PERSIST_PER_TOOL_CALL, and a row that stands in for 47 corpora must
  // never be the one evicted by that cap.
  const exposures: ExtractedFinding[] = [];
  for (const [via, set] of breachCorpora) {
    const corpora = [...set].sort();
    if (corpora.length === 0) continue;
    const kept = corpora.slice(0, MAX_BREACH_CORPORA_PER_EXPOSURE);
    exposures.push({
      kind: "breach_exposure",
      value: `Breach exposure (${via})`,
      context: {
        tool: toolName,
        via,
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

  // De-dup within this extraction.
  const seen = new Set<string>();
  const uniq: ExtractedFinding[] = [];
  for (const f of findings) {
    const k = checkpointKey(f.kind, f.value);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(f);
    if (uniq.length >= MAX_AUTO_PERSIST_PER_TOOL_CALL) break;
  }
  return uniq;
}

/** Walk every tool result on a step. Returns a de-duped, step-capped list. */
export function extractStepFindings(toolResults: unknown[] | null | undefined): Array<ExtractedFinding & { toolName: string }> {
  if (!Array.isArray(toolResults)) return [];
  const out: Array<ExtractedFinding & { toolName: string }> = [];
  const seen = new Set<string>();
  for (const tr of toolResults) {
    const t = tr as { toolName?: unknown; output?: unknown; result?: unknown };
    const name = typeof t?.toolName === "string" ? t.toolName : "";
    if (!name) continue;
    const output = (t.output ?? t.result) ?? null;
    const findings = extractFindings(name, output);
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
};

export type AutoPersistContext = {
  supabase: SupabaseInsertLike;
  threadId: string;
  userId: string;
  /** Caller-owned dedup set (same one used by incremental-persist checkpoints)
   *  so a value auto-recorded here also blocks the checkpoint from re-listing
   *  it, and vice versa. Seeded from prior checkpoints + prior artifacts. */
  seen: Set<string>;
};

export type AutoPersistResult = { inserted: number; skipped_duplicates: number; rows: Array<Record<string, unknown>> };

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

  return { inserted: safeRows.length, skipped_duplicates: dups, rows: safeRows };
}

/**
 * Seed the dedup set from artifacts already persisted for this thread, so a
 * re-run / recovery never re-inserts an existing (kind,value). Best-effort.
 */
export async function loadSeenArtifactKeys(
  supabase: { from: (t: string) => { select: (c: string) => { eq: (col: string, v: unknown) => Promise<{ data: Array<{ kind?: unknown; value?: unknown }> | null; error: unknown }> } } },
  threadId: string,
): Promise<Set<string>> {
  const seen = new Set<string>();
  try {
    const { data, error } = await supabase.from("artifacts").select("kind,value").eq("thread_id", threadId);
    if (error || !Array.isArray(data)) return seen;
    for (const r of data) {
      const k = typeof r?.kind === "string" ? r.kind : "";
      const v = typeof r?.value === "string" ? r.value : "";
      if (k && v) seen.add(checkpointKey(k, v));
    }
  } catch (e) {
    console.warn("[auto-persist-findings] loadSeenArtifactKeys failed:", (e as Error)?.message ?? e);
  }
  return seen;
}
