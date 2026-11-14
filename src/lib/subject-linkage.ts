/**
 * Whose is this contact? The POSITIVE half of subject authority (audit A01,
 * 2026-11-13).
 *
 * `isSubjectAuthorityEligible` (report-hygiene.ts) is a negative gate: it removes
 * quarantined, collision-flagged and analyst-rejected rows. It never asks whether
 * a row is the subject's. So a clean, high-confidence row about an ASSOCIATE
 * could headline the Subject Profile as the subject's own email or address.
 *
 * This module answers the positive question, and invents no linkage rule of its
 * own: it reads the agent assessment (`assessArtifacts`), which already derives
 * `isSeed`, `linkedToSeed` and `subjectLinkage` from the identity-cluster engine.
 *
 * What it deliberately does NOT read:
 *  - the analyst's review verdict. "Confirmed" says a value is real, not whose
 *    it is.
 *  - `linkage_confirmed` directly. A release reaches the assessment only by
 *    clearing the quarantine; it does not join the row to the seed. So a
 *    released row with no cluster link to the seed is still "unresolved" here.
 *    JD's decision A (2026-11-13): releasing a row from quarantine does not
 *    establish that it belongs to the subject.
 *  - the artifact's confidence. A high score on an unlinked row is a well
 *    supported fact about SOMEONE.
 *
 * `SUPPORTED_LINKAGE_MIN` (60) is the app's "supported" rung, the same bar the
 * rail uses. It is a threshold, not a calibrated 60% probability and not proof
 * of ownership, so a row that clears it is described as LINKED to the subject.
 *
 * It decides ownership only. It hides nothing: a row that is not the subject's
 * stays in every evidence table and is listed in the profile as unresolved.
 */
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { assessArtifacts, canonical, SUPPORTED_LINKAGE_MIN, type AgentAssessment, type AssessmentReport } from "@/lib/agent-assessment";
import { buildRejectedDerivationIds, isRejectedArtifact } from "@/lib/analyst-decisions";
import { effectiveConfidenceOrZero } from "@/lib/display-confidence";
import type { ReviewAdjustment } from "@/lib/intel";
import { normalizeTarget } from "@/lib/next-step-cards";
import { isNullResultValue, isSubjectAuthorityEligible, seedNameMatcher } from "@/lib/report-hygiene";

export type ProfileOwnership = "subject" | "unresolved";

/**
 * May this row be printed as the SUBJECT's own contact field?
 *
 * `assessment` is `assessArtifacts(...).byId[artifact.id]`; it is undefined for
 * meta rows, which are never assessed. The order of the rules is the contract:
 * quarantine wins over everything, including being the seed.
 */
export function profileOwnership(assessment: AgentAssessment | undefined): ProfileOwnership {
  if (!assessment || assessment.group === "quarantined") return "unresolved";
  if (assessment.isSeed) return "subject";
  const linkage = assessment.subjectLinkage;
  if (assessment.linkedToSeed === true && linkage !== null && linkage >= SUPPORTED_LINKAGE_MIN) return "subject";
  return "unresolved";
}

/**
 * Where a row stands for an ASSERTED profile attribute, once its claim is read
 * beside its linkage (JD's decision B, 2026-11-13).
 *
 * Linkage and claim are two questions. A conflict flag does not remove a
 * supported link, so `profileOwnership` is untouched by it. But a claim the case
 * record contradicts must not be printed as the subject's attribute until the
 * conflict is resolved. So:
 *  - "unresolved": not the subject's by linkage (`profileOwnership`);
 *  - "disputed":   the subject's by linkage, and the assessment put the row in
 *                  its `conflict` group. Listed with its linkage, never asserted;
 *  - "subject":    the subject's by linkage, claim not disputed.
 *
 * It reads the assessment's own `group`; it adds no conflict rule of its own.
 */
export type ProfileStanding = "subject" | "disputed" | "unresolved";

export function profileStanding(assessment: AgentAssessment | undefined): ProfileStanding {
  if (profileOwnership(assessment) !== "subject") return "unresolved";
  return assessment?.group === "conflict" ? "disputed" : "subject";
}

/** The words printed beside a contact field the profile asserts for the subject. */
export const PROFILE_NOTE_SEED = "Supplied as the case seed";
export const PROFILE_NOTE_LINKED = "Linked to the subject · ownership not independently verified";
export const PROFILE_NOTE_SEED_NAMED = "Named in the case seed";

type Reviews = Record<string, ReviewAdjustment> | undefined;

/**
 * Rows DERIVED from an analyst-rejected selector. The markdown export's
 * provenance rule (`buildReportMarkdown`): rejection follows provenance, so a
 * row pulled from a rejected email leaves the subject's sections with it.
 */
export function rejectedDerivedIds(artifacts: Artifact[], reviews: Reviews): Set<string> {
  const rejectedIds = new Set(artifacts.filter((a) => isRejectedArtifact(a, reviews?.[a.id])).map((a) => a.id));
  return buildRejectedDerivationIds(artifacts, rejectedIds, normalizeTarget);
}

const NAME_KINDS: ReadonlySet<string> = new Set(["name", "person"]);

/** On what basis a name is stated as the subject's. */
export type SubjectNameBasis = "seed" | "linked";

/**
 * Who the case names as its subject, and every other name it holds. One speaking
 * row per distinct name, so nothing is listed twice and nothing is dropped.
 */
export type SubjectNameReading = {
  /** The row that speaks for the subject's name, or null: no name is established. */
  asserted: Artifact | null;
  basis: SubjectNameBasis | null;
  /**
   * Rows of the asserted name that a shared selector joins to the seed, best
   * first. The only rows a personal detail (DOB, age) may be read from: a row
   * tied to the subject by its name alone may be a namesake's record.
   */
  selectorLinked: Artifact[];
  /** Tied to the subject, undisputed, not asserted: more than one such name, or a name beside the seed's. */
  linked: Artifact[];
  /** Tied to the subject, but the case record contradicts the claim (decision B). */
  disputed: Artifact[];
  /** In the case; nothing ties them to the subject (decision A covers a released row). */
  unresolved: Artifact[];
};

/**
 * The ONE rule for the subject's name (audit A01, Name half; JD approved v2 on
 * 2026-11-13). Every surface that names the subject reads it through
 * `pickSubjectName` (report-hygiene.ts) or directly.
 *
 *  1. Candidates are name/person rows that pass the gates the profile's contact
 *     fields use: not quarantined, collision-flagged or rejected; not derived
 *     from a rejected selector; not a "no results" row.
 *  2. A name is tied to the subject on one of two bases:
 *       seed   - the analyst typed it: the row equals the whole seed (`isSeed`),
 *                or its words appear together and in order in the typed seed
 *                (`seedNameMatcher`). A name row that merely repeats a selector
 *                seed (a display name equal to the handle) is not a name;
 *       linked - `profileOwnership` says the row is the subject's by linkage.
 *  3. A tied name whose claim the case record disputes (the assessment's
 *     `conflict` group) is never asserted. Its tie is kept; it is listed apart.
 *  4. Asserted: the seed-named name. Without one, the single linked name. Two or
 *     more DIFFERENT linked names are not reconciled by score, so none is
 *     asserted; a disputed linked name counts as one of them, because dropping
 *     it first would settle the dispute in the other name's favour. When the
 *     seed names a person (any name row, eligible or not), only that name may be
 *     asserted.
 *  5. Every other candidate is returned, grouped by where it stands.
 *
 * It reads the agent assessment and the seed text. It adds no score, reads no
 * review verdict into ownership, and never looks at a row's confidence except to
 * order rows that already stand equal (then value, then id, so the order rows
 * arrived in decides nothing).
 */
export function readSubjectName(
  artifacts: Artifact[],
  reviews?: Reviews,
  seedValue?: string | null,
  assessment: AssessmentReport = assessArtifacts(artifacts, seedValue ?? null, reviews),
): SubjectNameReading {
  const namedInSeed = seedNameMatcher(seedValue);
  const derived = rejectedDerivedIds(artifacts, reviews);
  const byRank = (a: Artifact, b: Artifact) =>
    effectiveConfidenceOrZero(b) - effectiveConfidenceOrZero(a) ||
    String(a.value ?? "").localeCompare(String(b.value ?? "")) ||
    String(a.id).localeCompare(String(b.id));

  type Name = { standing: ProfileStanding; seedNamed: boolean; wholeSeed: boolean; rows: Array<{ row: Artifact; standing: ProfileStanding }> };
  const names = new Map<string, Name>();
  let seedNamesPerson = false;
  // A selector seed (a handle, an email) that some non-name row repeats. A NAME
  // row that equals it is a display name echoing the handle, not a person's name.
  const selectorSeed = artifacts.some(
    (a) => !NAME_KINDS.has(String(a.kind ?? "").toLowerCase()) && assessment.byId[a.id]?.isSeed === true,
  );
  for (const a of artifacts) {
    const kind = String(a.kind ?? "").toLowerCase();
    if (!NAME_KINDS.has(kind)) continue;
    const value = String(a.value ?? "");
    const assessed = assessment.byId[a.id];
    const canon = canonical(kind, value);
    const echo = assessed?.isSeed === true && selectorSeed;
    const wholeSeed = assessed?.isSeed === true && !echo;
    // Compare the canonical name, as the grouping below does: "Sam Example (age
    // 41)" is the name "Sam Example", and the annotation's words are not in the seed.
    const seedNamed = wholeSeed || namedInSeed(canon || value);
    // Read from EVERY name row, eligible or not: a seed whose own name sits in
    // quarantine still names that person, and nobody else takes the place.
    if (seedNamed) seedNamesPerson = true;
    if (!isSubjectAuthorityEligible(a, reviews?.[a.id]) || derived.has(a.id) || isNullResultValue(a.value, a.source)) continue;
    // `canonical` strips a trailing parenthetical, so a value that is ONLY an
    // annotation ("(redacted)") has no canonical form. It is still a row in the
    // case: key it by its own text so it is listed, never silently dropped.
    const key = (canon || value.trim().toLowerCase()).replace(/\s+/g, " ");
    if (!key) continue;
    // An annotation-only value and a handle echo are rows in the case, never a
    // name tied to the subject: listed as unresolved, never asserted, and never
    // counted against the real linked name.
    const standing: ProfileStanding = !canon || echo
      ? "unresolved"
      : seedNamed
        ? (assessed?.group === "conflict" ? "disputed" : "subject")
        : profileStanding(assessed);
    const name = names.get(key) ?? { standing: "unresolved" as ProfileStanding, seedNamed: false, wholeSeed: false, rows: [] };
    // One disputed row disputes the name; otherwise one tied row ties it.
    if (standing === "disputed" || (standing === "subject" && name.standing === "unresolved")) name.standing = standing;
    name.seedNamed = name.seedNamed || seedNamed;
    name.wholeSeed = name.wholeSeed || wholeSeed;
    name.rows.push({ row: a, standing });
    names.set(key, name);
  }

  /** The row that speaks for a name: one that itself holds the name's standing. */
  const speaker = (n: Name): Artifact =>
    n.rows.filter((r) => n.standing === "unresolved" || r.standing === n.standing).map((r) => r.row).sort(byRank)[0];
  const byName = (a: Name, b: Name) => byRank(speaker(a), speaker(b));
  const all = Array.from(names.values());
  const tied = all.filter((n) => n.standing === "subject");
  const seedNamed = tied.filter((n) => n.seedNamed).sort((a, b) => Number(b.wholeSeed) - Number(a.wholeSeed) || byName(a, b));
  // Every name the seed ties to the subject, disputed ones included.
  const seedNamedAll = all.filter((n) => n.seedNamed && n.standing !== "unresolved");
  const linkedOnly = tied.filter((n) => !n.seedNamed);
  // Every name the linkage ties to the subject, disputed ones included.
  const linkedByOwnership = all.filter((n) => !n.seedNamed && n.standing !== "unresolved").length;

  let asserted: Name | null = null;
  let basis: SubjectNameBasis | null = null;
  // The whole seed is the analyst's own subject. Otherwise one name the seed
  // names is asserted; two are not reconciled by score, like two linked names.
  if (seedNamed.length > 0 && (seedNamed[0].wholeSeed || seedNamedAll.length === 1)) {
    asserted = seedNamed[0];
    basis = "seed";
  } else if (!seedNamesPerson && linkedOnly.length === 1 && linkedByOwnership === 1) {
    asserted = linkedOnly[0];
    basis = "linked";
  }

  const selectorLinked = asserted
    ? asserted.rows
        .filter(({ row, standing }) => {
          const assessed = assessment.byId[row.id];
          return standing === "subject" && assessed?.isSeed !== true && profileOwnership(assessed) === "subject";
        })
        .map((r) => r.row)
        .sort(byRank)
    : [];

  const rest = all.filter((n) => n !== asserted).sort(byName);
  return {
    asserted: asserted ? speaker(asserted) : null,
    basis,
    selectorLinked,
    linked: rest.filter((n) => n.standing === "subject").map(speaker),
    disputed: rest.filter((n) => n.standing === "disputed").map(speaker),
    unresolved: rest.filter((n) => n.standing === "unresolved").map(speaker),
  };
}
