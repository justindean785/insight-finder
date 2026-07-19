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

/** Kinds we will auto-persist. Nothing sensitive is on this list. */
const ALLOWED_KINDS = new Set<string>([
  "url", "email", "breach", "social_account", "github_repo", "github_account",
  "phone", "domain", "ip_address", "leak_paste", "document",
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
    case "breach": {
      if (v.length > 120) return null;
      return { kind: "breach", value: v };
    }
    case "github_account":
    case "github_repo":
    case "social_account": {
      if (v.length > 200) return null;
      return { kind: k, value: v };
    }
  }
  return null;
}

function pushUrl(out: ExtractedFinding[], url: unknown, ctx: Record<string, unknown>) {
  const n = normalizeFinding("url", url);
  if (n) out.push({ kind: n.kind, value: n.value, context: ctx, rawConfidence: 30 });
}

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

  // 1) HIBP-style breach payloads: { data: { breaches: [{ Name|name }] } }
  const hibpBreaches = ((o.data as { breaches?: unknown } | null)?.breaches) ?? o.breaches;
  if (Array.isArray(hibpBreaches)) {
    for (const b of hibpBreaches.slice(0, MAX_AUTO_PERSIST_PER_TOOL_CALL)) {
      const name = (b as { Name?: unknown; name?: unknown })?.Name ?? (b as { name?: unknown })?.name;
      push("breach", name, { via: "hibp_style" }, 55);
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

  // 5) socialfetch_lookup — surface the profile URL if the platform confirmed a hit.
  if (toolName === "socialfetch_lookup" && o.ok === true) {
    const data = o.data as Record<string, unknown> | null;
    const profileUrl = (data as { url?: unknown; profile_url?: unknown })?.url
      ?? (data as { profile_url?: unknown })?.profile_url
      ?? o.url;
    pushUrl(findings, profileUrl, { tool: toolName, via: "profile" });
    const handle = (data as { username?: unknown })?.username;
    if (typeof handle === "string") {
      push("social_account", handle, { via: "socialfetch" }, 55);
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
