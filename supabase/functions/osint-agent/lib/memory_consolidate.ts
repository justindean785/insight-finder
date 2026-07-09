/**
 * lib/memory_consolidate.ts — C-2: cap fallback confidence + hard-split same-name/
 * different-person before a memory_save entry reaches persistent case memory.
 *
 * Why this exists: in run e29aa8c9, minimax_correlate timed out ("exceeded 12000ms
 * tool timeout") and the very next memory_save wrote, at confidence 98: "anastacio
 * 'tosh' ben cero is the confirmed primary subject across both taciocero@me.com AND
 * nicole@bay2pacificre.com." The two emails resolve to different people (Anastacio
 * Cero, DOB 1983-12-06, Brentwood/Oakley vs. "Sheena Cero", Lodi CA) who share only a
 * surname and an area code — a weak-overlap merge poisoned into persistent memory at
 * near-certain confidence, on a run where the one verification step (correlate) had
 * already failed. agent_memory's own upsert ratchets confidence with
 * GREATEST(old, new) (never down), so the only safe place to stop this is BEFORE the
 * write — this module is that gate.
 *
 * DESIGN: reuse C-1 (lib/cluster.ts) as the sole authority on "same subject" — this
 * module NEVER re-derives a merge decision. It only asks "which C-1 subject_id(s) does
 * this memory_save entry's claim touch?" and:
 *   - touches 2+ subject_ids  → BLOCKED. Never written; logged as a candidate_merge
 *     with a human-readable reason (e.g. "first-name conflict: Sheena vs Anastacio").
 *   - touches 0 resolvable subjects AND correlate failed AND the entry makes a
 *     multi-selector claim → UNRESOLVED. Written as "unresolved — correlation
 *     failed", confidence forced low. Nothing is silently dropped.
 *   - touches exactly 1 subject → ALLOWED, but confidence is capped at that subject's
 *     own C-1-promoted ceiling (never above it, and never above 74 — "Possible" —
 *     unless that subject already carries a strong join key per C-1's own promotion
 *     rules, i.e. ≥2 independent sources or a self-admission).
 */

import {
  clusterArtifacts, collectKnownHandles, strongTokens,
  normEmail, normPhoneE164, foldHandle,
  type Artifact, type ClusterMember,
} from "./cluster.ts";

export interface MemoryEntry {
  kind: string;
  subject: string;
  subject_kind?: string;
  related_values?: string[];
  content: string;
  confidence: number;
}

export interface MemoryReview {
  verdict: "allow" | "blocked" | "unresolved";
  /** The entry to actually persist for 'allow'/'unresolved'; unchanged reference
   *  fields, confidence/content adjusted per the rules above. Present but UNUSED
   *  (never written) when verdict is 'blocked'. */
  entry: MemoryEntry;
  /** Populated for 'blocked'/'unresolved' — why, in analyst-readable language. */
  reason?: string;
  /** The C-1 subject_id(s) the entry's claim resolved to (0, 1, or 2+). */
  subjectIds: string[];
}

// A cap ceiling below JD's "Likely" (75) tier for any claim not backed by a strong
// join key — mirrors the floor lib/cluster.ts's promoteConfidence() itself enforces.
const NO_STRONG_KEY_CEILING = 74;
// Below this, an unresolved/blocked claim is downgraded further — floor for the
// "we genuinely don't know" state, distinct from a normal weak single-source lead.
const UNRESOLVED_CONFIDENCE_CAP = 40;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// ---- Token index: reuse C-1's own selector tokens, so "same selector" here is
// pixel-identical to what union-find already used to (not) merge these people. ------
export interface TokenIndex {
  tokenToSubject: Map<string, string>;
  membersBySubject: Map<string, ClusterMember[]>;
}

export function buildTokenIndex(members: ClusterMember[], knownHandles: Set<string>): TokenIndex {
  const tokenToSubject = new Map<string, string>();
  const membersBySubject = new Map<string, ClusterMember[]>();
  for (const m of members) {
    if (!m.subject_id) continue;
    (membersBySubject.get(m.subject_id) ?? membersBySubject.set(m.subject_id, []).get(m.subject_id)!).push(m);
    for (const tok of strongTokens(m, knownHandles)) {
      if (!tokenToSubject.has(tok)) tokenToSubject.set(tok, m.subject_id);
    }
  }
  return { tokenToSubject, membersBySubject };
}

/** Normalize an arbitrary string (a related_values entry or a content substring) into
 * the same token vocabulary strongTokens() uses, IF it looks like a genuine selector —
 * never folds arbitrary prose into a handle token unless it matches a KNOWN handle
 * (same anti-false-positive whitelist C-1 uses), so "dob 1983-12-06" or "ca area codes
 * 925" never accidentally resolves to a subject. */
function tokensForRawString(raw: string, knownHandles: Set<string>): string[] {
  const out: string[] = [];
  const s = raw.trim();
  if (!s) return out;
  const email = normEmail(s);
  if (email) out.push(`email:${email}`);
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 10 && digits.length <= 11 && /^[\d()+\-.\s]+$/.test(s)) {
    const p = normPhoneE164(s);
    if (p) out.push(`phone:${p}`);
  }
  const folded = foldHandle(s);
  if (folded.length >= 3 && knownHandles.has(folded)) out.push(`handle:${folded}`);
  return out;
}

/** Every candidate selector string an entry asserts: the structured related_values
 * plus any emails embedded in free-text content (the historical bug's false claim
 * lived ONLY in prose, not in related_values — so content must be scanned too). */
function candidateStrings(entry: MemoryEntry): string[] {
  const out = [...(entry.related_values ?? [])];
  const emails = entry.content.match(EMAIL_RE);
  if (emails) out.push(...emails);
  return out;
}

interface ResolveResult { subjectIds: string[]; candidateCount: number; matchedCount: number }

function resolveSubjectIds(entry: MemoryEntry, index: TokenIndex, knownHandles: Set<string>): ResolveResult {
  const candidates = candidateStrings(entry);
  const found = new Set<string>();
  let matched = 0;
  for (const raw of candidates) {
    for (const tok of tokensForRawString(raw, knownHandles)) {
      const subjectId = index.tokenToSubject.get(tok);
      if (subjectId) { found.add(subjectId); matched++; break; }
    }
  }
  return { subjectIds: [...found], candidateCount: candidates.length, matchedCount: matched };
}

// ---- Human-readable conflict reason (for the candidate_merge audit log) -----------
function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

function subjectFirstNames(members: ClusterMember[]): string[] {
  const names = members.filter((m) => m.kind === "name").map((m) => m.value);
  return [...new Set(names.map(firstNameOf).filter(Boolean))];
}

/** Describe WHY the referenced subjects are separate, for the audit log — reuses C-1's
 * own (already-correct) decision by explaining the facts, never re-deciding anything.
 * A real claim can span more than 2 fragmented subjects (sparse cross-linking metadata
 * splits one person's own facts into several small C-1 clusters when nothing explicitly
 * ties them together) — so this checks EVERY pair for a first-name conflict before
 * falling back to the generic "no shared strong selector" reason. */
export function describeConflict(subjectIds: string[], index: TokenIndex): string {
  if (subjectIds.length < 2) return "multiple subjects referenced";
  const namesById = new Map(subjectIds.map((id) => [id, subjectFirstNames(index.membersBySubject.get(id) ?? [])]));
  for (let i = 0; i < subjectIds.length; i++) {
    for (let j = i + 1; j < subjectIds.length; j++) {
      const namesA = namesById.get(subjectIds[i]) ?? [];
      const namesB = namesById.get(subjectIds[j]) ?? [];
      if (namesA.length && namesB.length && !namesA.some((n) => namesB.includes(n))) {
        return `first-name conflict: ${namesA.join("/")} vs ${namesB.join("/")}`;
      }
    }
  }
  return `${subjectIds.length} distinct C-1 subjects referenced with no shared strong selector — never merged by clustering`;
}

// ---- Main review --------------------------------------------------------------
/**
 * Review one memory_save entry against the thread's C-1-clustered artifacts.
 * `threadArtifacts` are the RAW (unclustered) artifacts — clustering runs here so the
 * caller doesn't need to thread cluster state through separately.
 */
export function reviewMemoryEntry(
  entry: MemoryEntry,
  threadArtifacts: Artifact[],
  correlateFailed: boolean,
): MemoryReview {
  const knownHandles = collectKnownHandles(threadArtifacts);
  const { members } = clusterArtifacts(threadArtifacts);
  const index = buildTokenIndex(members, knownHandles);
  const { subjectIds, candidateCount } = resolveSubjectIds(entry, index, knownHandles);
  const crossSelectorClaim = candidateCount >= 2;

  if (subjectIds.length >= 2) {
    return { verdict: "blocked", entry, reason: describeConflict(subjectIds, index), subjectIds };
  }

  if (subjectIds.length === 0) {
    if (correlateFailed && crossSelectorClaim) {
      return {
        verdict: "unresolved",
        entry: {
          ...entry,
          content: `unresolved — correlation failed. Original unverified claim: ${entry.content}`,
          confidence: Math.min(entry.confidence, UNRESOLVED_CONFIDENCE_CAP),
        },
        reason: "minimax_correlate failed this cycle and no C-1 cluster corroborates this cross-selector claim",
        subjectIds: [],
      };
    }
    // No structural evidence either way (e.g. a pure "lesson"/"pattern" entry with no
    // selectors) — allow, but never trust an ungrounded confidence above Possible.
    return { verdict: "allow", entry: { ...entry, confidence: Math.min(entry.confidence, NO_STRONG_KEY_CEILING) }, subjectIds: [] };
  }

  // Exactly one subject — the legitimate case. Cap by THAT subject's own C-1-promoted
  // ceiling; a strong join key (self-admission / ≥2 independent sources) is exactly
  // what let cluster.ts's promoteConfidence push a member to ≥75 in the first place.
  const subjectId = subjectIds[0];
  const subjMembers = index.membersBySubject.get(subjectId) ?? [];
  const maxPromoted = subjMembers.length ? Math.max(...subjMembers.map((m) => m.promoted_confidence)) : NO_STRONG_KEY_CEILING;
  const hasStrongKey = maxPromoted >= 75;
  const ceiling = hasStrongKey ? maxPromoted : Math.min(maxPromoted, NO_STRONG_KEY_CEILING);
  return { verdict: "allow", entry: { ...entry, confidence: Math.min(entry.confidence, ceiling) }, subjectIds: [subjectId] };
}

/** Batch helper: review every entry in a memory_save call. Returns the entries safe to
 * persist (allow + unresolved, both written — never silently dropped) and the blocked
 * ones separately (candidate_merge log only, never persisted as an identity claim). */
export function reviewMemoryBatch(
  entries: MemoryEntry[],
  threadArtifacts: Artifact[],
  correlateFailed: boolean,
): { toPersist: MemoryEntry[]; candidates: Array<{ entry: MemoryEntry; reason: string; subjectIds: string[] }> } {
  const toPersist: MemoryEntry[] = [];
  const candidates: Array<{ entry: MemoryEntry; reason: string; subjectIds: string[] }> = [];
  for (const entry of entries) {
    const review = reviewMemoryEntry(entry, threadArtifacts, correlateFailed);
    if (review.verdict === "blocked") {
      candidates.push({ entry, reason: review.reason ?? "blocked", subjectIds: review.subjectIds });
    } else {
      toPersist.push(review.entry);
      if (review.verdict === "unresolved") {
        candidates.push({ entry: review.entry, reason: review.reason ?? "unresolved", subjectIds: review.subjectIds });
      }
    }
  }
  return { toPersist, candidates };
}
