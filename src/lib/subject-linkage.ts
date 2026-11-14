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
 *    Whether an explicit release should establish ownership by itself is an
 *    open ruling, not something this module decides.
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
import { SUPPORTED_LINKAGE_MIN, type AgentAssessment } from "@/lib/agent-assessment";

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

/** The words printed beside a contact field the profile asserts for the subject. */
export const PROFILE_NOTE_SEED = "Supplied as the case seed";
export const PROFILE_NOTE_LINKED = "Linked to the subject · ownership not independently verified";
