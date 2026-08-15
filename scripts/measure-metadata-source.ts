#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
/**
 * Population measurement for the metadata-provenance boundary. READ-ONLY.
 *
 * THE INVARIANT UNDER TEST
 *   Model-authored provenance may DISCLOSE or REDUCE authority.
 *   It must never CREATE authority.
 *
 * `applyEvidenceCaps` (confidence.ts:327) unions `input.sources` with
 * `metadataSourceLabels(metadata)` (:301-311), which reads `metadata.source` and
 * `metadata.sources` out of the unvalidated `z.record(z.unknown())` blob that
 * `record_artifacts` (tool-registry.ts:4532) writes through verbatim. Measured
 * on a single case, that lets a model raise an artifact's cap 55 -> 95 and null
 * its `reason_not_confirmed` with zero tool calls. This script asks how much of
 * the real population that boundary actually touches, BEFORE any code changes.
 *
 * WHY DENO AND NOT .mjs — it imports the REAL `applyEvidenceCaps`,
 * `deriveStatus` and `classifySource` from the edge function. A Node script
 * would have to reimplement the cap logic, and a second implementation of
 * evidence policy is the exact failure mode this work exists to remove.
 *
 * WHY IT PRINTS NO EVIDENCE VALUES — counts and grouped provenance SHAPES only.
 * Artifact values are case material about real people; the question here is
 * structural, so nothing identifying needs to leave the database.
 *
 * USAGE — credentials come from the environment and are never logged:
 *   export SUPABASE_EMAIL=you@example.com
 *   export SUPABASE_PASSWORD='…'
 *   deno run --allow-net --allow-env scripts/measure-metadata-source.ts
 *
 * Reads only what RLS already grants the signed-in analyst.
 */
import { applyEvidenceCaps, deriveStatus } from "../supabase/functions/osint-agent/confidence.ts";
import { classifySource, type SourceClass } from "../supabase/functions/osint-agent/source-classification.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://skzqwbyvmwqarfgfvyky.supabase.co";
// Public anon key — same one the shipped client embeds; carries no privilege
// beyond what the authenticated session already has under RLS.
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrenF3Ynl2bXdxYXJmZ2Z2eWt5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3ODg5MTksImV4cCI6MjA5NTM2NDkxOX0.B2k5sI10zk1nxjZdXEFxuVV3B755FxDFGkT6TfWY6TE";

const email = Deno.env.get("SUPABASE_EMAIL");
const password = Deno.env.get("SUPABASE_PASSWORD");
if (!email || !password) {
  console.error("SUPABASE_EMAIL and SUPABASE_PASSWORD must be set in the environment.");
  console.error("They are read from env only, never written to disk or logged.");
  Deno.exit(2);
}

async function signIn(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`auth failed: ${res.status} ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  if (!j.access_token) throw new Error("no access token returned");
  return j.access_token;
}

async function page<T>(token: string, path: string, select: string): Promise<T[]> {
  const out: T[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}?select=${encodeURIComponent(select)}`, {
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${token}`,
        Range: `${from}-${from + SIZE - 1}`,
        "Range-Unit": "items",
      },
    });
    if (!res.ok) throw new Error(`${path} read failed: ${res.status} ${(await res.text()).slice(0, 120)}`);
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < SIZE) return out;
  }
}

// ---------------------------------------------------------------------------
// Provenance helpers. These MIRROR the shipped code's own splitting rather than
// inventing a new one: applyEvidenceCaps (confidence.ts:317-323) already splits
// a compound label that names several tools ("breach_check+leakcheck+…"). A
// measurement that failed to split the same way reported 11 false positives on a
// 98-artifact sample, including an 85->50 on a legitimately 3-tool row.
// ---------------------------------------------------------------------------
const splitCompound = (label: string): string[] =>
  label.split(/\s*[+,]\s*/).map((t) => t.trim()).filter(Boolean);

const slugOf = (token: string): string =>
  token.toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim();

function metaLabels(meta: Record<string, unknown> | null): string[] {
  if (!meta) return [];
  const out: string[] = [];
  if (typeof meta.source === "string") out.push(meta.source);
  if (Array.isArray(meta.sources)) for (const s of meta.sources) if (typeof s === "string") out.push(s);
  return out;
}

function classesOf(labels: string[]): SourceClass[] {
  const set = new Set<SourceClass>();
  for (const l of labels) {
    const whole = classifySource(l);
    if (whole !== "unknown") { set.add(whole); continue; }
    for (const t of splitCompound(l)) {
      const c = classifySource(t);
      if (c !== "unknown") set.add(c);
    }
  }
  return [...set];
}

type Artifact = {
  id: string; thread_id: string; kind: string; source: string | null;
  confidence: number | null; status: string | null;
  metadata: Record<string, unknown> | null;
};
type ToolRow = { thread_id: string; tool_name: string };

// ---------------------------------------------------------------------------

const token = await signIn();
console.log("signed in; reading (read-only)…\n");

const artifacts = await page<Artifact>(token, "artifacts", "id,thread_id,kind,source,confidence,status,metadata");
const tools = await page<ToolRow>(token, "tool_usage_log", "thread_id,tool_name");

/** Which tool slugs actually EXECUTED on each thread. This is the only
 *  execution-attested provenance root available today. */
const executed = new Map<string, Set<string>>();
for (const t of tools) {
  if (!t.thread_id || !t.tool_name) continue;
  (executed.get(t.thread_id) ?? executed.set(t.thread_id, new Set()).get(t.thread_id)!).add(t.tool_name.toLowerCase());
}

let withMeta = 0, capChanged = 0, statusChanged = 0, noAttested = 0, unrootedSource = 0;
const capDeltas = new Map<string, number>();       // "95->55" -> count
const shapes = new Map<string, number>();          // grouped provenance shape -> count
const unrootedTokens = new Map<string, number>();  // slug the log never saw -> count

for (const a of artifacts) {
  const meta = a.metadata ?? null;
  const surface = a.source ? [a.source] : [];
  const mLabels = metaLabels(meta);
  if (mLabels.length) withMeta++;

  // Run 1 — today: metadata labels participate and can RAISE the cap.
  const today = applyEvidenceCaps({
    rawConfidence: a.confidence ?? 50, sources: surface, kind: a.kind, metadata: meta,
  });
  // Run 2 — the invariant: metadata cannot create authority. min() keeps every
  // existing demotion, because whichever run is more conservative wins.
  const noMeta = applyEvidenceCaps({
    rawConfidence: a.confidence ?? 50, sources: surface, kind: a.kind, metadata: null,
  });
  const shippedCap = Math.min(today.cap, noMeta.cap);

  if (shippedCap !== today.cap) {
    capChanged++;
    const k = `${today.cap}->${shippedCap}`;
    capDeltas.set(k, (capDeltas.get(k) ?? 0) + 1);

    // (4) does the STATUS move, not just the number?
    const sTodayCls = classesOf([...surface, ...mLabels]);
    const sShipCls = classesOf(surface);
    const stToday = deriveStatus({
      requested: a.status, reasonNotConfirmed: today.reason_not_confirmed ?? null, sourceClasses: sTodayCls,
    });
    const stShip = deriveStatus({
      requested: a.status, reasonNotConfirmed: noMeta.reason_not_confirmed ?? null, sourceClasses: sShipCls,
    });
    if (stToday !== stShip) {
      statusChanged++;
      shapes.set(`${stToday} -> ${stShip}`, (shapes.get(`${stToday} -> ${stShip}`) ?? 0) + 1);
    }
  }

  // (5)/(6) can the surface provenance be tied to something that actually ran?
  const ran = executed.get(a.thread_id) ?? new Set<string>();
  const surfaceTokens = surface.flatMap(splitCompound).map(slugOf).filter(Boolean);
  const rooted = surfaceTokens.filter((t) => ran.has(t));
  if (surfaceTokens.length === 0) {
    noAttested++;
  } else if (rooted.length === 0) {
    unrootedSource++;
    for (const t of surfaceTokens.slice(0, 3)) unrootedTokens.set(t, (unrootedTokens.get(t) ?? 0) + 1);
  }
}

const top = (m: Map<string, number>, n = 12) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `    ${String(v).padStart(6)}  ${k}`).join("\n") || "    (none)";

console.log("=".repeat(72));
console.log("METADATA-PROVENANCE BOUNDARY — POPULATION MEASUREMENT (read-only)");
console.log("=".repeat(72));
console.log(`1. artifacts scanned                                    ${artifacts.length}`);
console.log(`2. carrying metadata.source / metadata.sources          ${withMeta}`);
console.log(`3. cap changes when metadata cannot raise authority     ${capChanged}`);
console.log(`4.   ...of which STATUS also changes                    ${statusChanged}`);
console.log(`5. no surface provenance at all                         ${noAttested}`);
console.log(`6. surface source not tied to any executed tool         ${unrootedSource}`);
console.log(`\n   (threads with tool_usage_log rows: ${executed.size}; tool rows: ${tools.length})`);
console.log("\nCAP DELTAS (today -> invariant-respecting):");
console.log(top(capDeltas));
console.log("\nSTATUS TRANSITIONS:");
console.log(top(shapes));
console.log("\nSURFACE TOKENS THE TOOL LOG NEVER SAW (shape only, no values):");
console.log(top(unrootedTokens));
console.log("\nNo artifact values were read into this output.");
