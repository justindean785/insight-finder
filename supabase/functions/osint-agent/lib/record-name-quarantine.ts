/**
 * record-name-quarantine — the write-path linkage gate for MODEL-AUTHORED rows.
 *
 * ## The hole this closes (a username-seed production case, 2026-09-23 — SANITIZED:
 * every handle, person and organisation below is fictional; the shape is real)
 *
 * Seed: the username `quietfalcon77`. A name-only breach lookup on "Jordan Vale"
 * came back with 47 same-name identities, and `auto-persist-findings` correctly
 * quarantined its echo (`subject_unlinked`: "harvested from a name-only query").
 * The model then web-searched that SAME name and wrote what it found itself,
 * through `record_artifacts`:
 *
 *   85  name          Jordan Vale - Midvale Chamber CEO
 *   75  legal_record  Jordan R. Vale - legislative staff directory record
 *   70  source_person Jordan R. Vale - CEO, Midvale Chamber of Commerce
 *   70  social_profile Civic directory profile - Jordan Vale
 *
 * None of them carried `subject_unlinked`. The auto-persist gate keys on QUERY
 * SHAPE and never sees these rows; `record_artifacts`' own collision gate fires
 * only when the MODEL flags a row unrelated. So four strangers entered the case
 * at full subject authority, on a name the engine had itself already ruled
 * unlinked one write earlier.
 *
 * ## The rule
 *
 * Same invariant as `lib/unproven-linkage.ts` (#581), applied one boundary over:
 * **authority is not inherited from a name whose linkage is unproven.** A row
 * whose value names a person the thread has ACTIVELY quarantined inherits that
 * quarantine, with a reason naming the parent. Collect everywhere, promote
 * nowhere: the row is written, disclosed, and releasable, never deleted.
 *
 * Exempt, exactly as the auto-persist gate is: a name the SEED itself links
 * (`seedLinksQueriedName` semantics — every name token appears in the seed).
 * An investigation opened ON a name asserts that name as the subject's.
 *
 * A released parent (`linkage_confirmed: true`) is not a quarantine and taints
 * nothing — the same predicate as `buildRefusedKeys` and the frontend's
 * `isQuarantined`.
 *
 * Zero imports on purpose: pure, and testable without the tool graph.
 */

/** Kinds whose ACTIVE quarantine makes their value a tainted person name. */
const PERSON_NAME_KINDS = new Set(["name", "person", "source_person"]);

export type ThreadRow = { kind?: unknown; value?: unknown; metadata?: unknown };

export type QuarantinedName = { tokens: string[]; value: string; reason: string | null };

function tokens(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);
}

/** Kill switch, read at CALL TIME so it takes effect on the running build. */
export function recordNameQuarantineEnabled(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  return (env("RECORD_NAME_QUARANTINE_DISABLED") ?? "").trim().toLowerCase() !== "true";
}

/**
 * Person names this thread has ACTIVELY quarantined. A name must carry at least
 * two tokens of two or more characters — a bare first name ("Jordan") would taint
 * every row that mentions anyone called Jordan, which is the over-reach this gate
 * must not have.
 */
export function quarantinedPersonNames(rows: readonly ThreadRow[] | null | undefined): QuarantinedName[] {
  const out: QuarantinedName[] = [];
  const seen = new Set<string>();
  for (const row of rows ?? []) {
    const kind = typeof row?.kind === "string" ? row.kind.toLowerCase() : "";
    if (!PERSON_NAME_KINDS.has(kind)) continue;
    const meta = (row?.metadata && typeof row.metadata === "object" ? row.metadata : null) as
      | Record<string, unknown>
      | null;
    if (meta?.subject_unlinked !== true || meta?.linkage_confirmed === true) continue;
    const value = typeof row.value === "string" ? row.value.trim() : "";
    const t = tokens(value).filter((x) => x.length >= 2);
    if (t.length < 2) continue;
    const key = [...t].sort().join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = typeof meta?.subject_unlinked_reason === "string" ? meta.subject_unlinked_reason : null;
    out.push({ tokens: t, value, reason });
  }
  return out;
}

/** Does the seed durably link this name? Mirrors `seedLinksQueriedName`. */
function seedLinks(seed: string | null | undefined, name: QuarantinedName): boolean {
  const s = new Set(tokens(seed ?? ""));
  if (s.size === 0) return false;
  return name.tokens.every((t) => s.has(t));
}

/**
 * The quarantine a model-authored row inherits, or null. Shaped exactly like
 * `derivedUnlinkedContext` (`subject_unlinked` + `subject_unlinked_reason` +
 * machine-readable parent) so every existing reader honours it unchanged.
 */
export function inheritedNameQuarantine(
  value: string,
  quarantined: readonly QuarantinedName[],
  seed: string | null | undefined,
): Record<string, unknown> | null {
  if (!quarantined.length) return null;
  const have = new Set(tokens(value));
  for (const q of quarantined) {
    if (!q.tokens.every((t) => have.has(t))) continue;
    if (seedLinks(seed, q)) continue;
    const because = q.reason ? ` — that name was quarantined because: ${q.reason}` : "";
    return {
      subject_unlinked: true,
      subject_unlinked_reason:
        `names "${q.value}", a person this investigation has not linked to the subject${because}. ` +
        `Recorded for review; it carries no subject authority until the name is corroborated or an analyst confirms the linkage.`,
      unproven_linkage_parent: `name:${q.tokens.join(" ")}`,
    };
  }
  return null;
}
