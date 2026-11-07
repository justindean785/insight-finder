/**
 * set-subject.ts — the analyst names the subject of a case that has none.
 *
 * THE DEFECT THIS CLOSES. A case whose first message is only an upload is stored
 * with the raw "Attached files:" markdown as its `seed_value` and `seed_type`
 * "other" (the edge cannot read a selector out of it). The identity-cluster
 * engine is keyed on the seed, so every row in that case reads "Unresolved":
 * there is no subject for anything to link to, however strong the evidence.
 *
 * SHAPE. Modelled on `releasePatch` (quarantine-release.ts): a pure function that
 * returns exactly the patch, or `null`. The guards ARE the feature, because the
 * patch rewrites `threads.seed_value`, which keys the identity-cluster engine,
 * and `threads.seed_type`, which the edge reads as the case's seed kind on its
 * next turn (auth.ts).
 *
 *  - Only a case with NO subject (empty, or an attachment-only seed). A case
 *    with any typed seed — a free-text name included — already has the subject
 *    its analyst chose; this must never be a one-click re-seed of a real case.
 *  - Only a concrete selector whose value parses as its own kind. Never a name,
 *    location or free text: name equality is never linkage (T1-2 §8).
 *  - Never a row the engine has withheld authority from (`isClusterIneligible`:
 *    quarantine and collision flags), nor a conflicted or false-positive row.
 *
 * Nothing here touches confidence, evidence ranking or the row itself.
 */
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { attachmentOnlyNames } from "@/lib/attachments";
import { isClusterIneligible } from "@/lib/report-hygiene";
import { detectSeed, formatThreadTitle, type SeedKind } from "@/lib/seed";

export type SubjectPatch = { seed_value: string; seed_type: SeedKind; title: string };

/** Artifact kind spellings that are concrete selectors, mapped to the seed kind. */
const SELECTOR_KIND: Record<string, SeedKind> = {
  email: "email",
  phone: "phone",
  username: "username",
  handle: "username",
  domain: "domain",
  subdomain: "domain",
  ip: "ip",
  ip_address: "ip",
  crypto_wallet: "crypto",
  wallet: "crypto",
};

/** True when the case has no subject an analyst chose: an empty seed, or an upload. */
export function caseLacksSubject(seedValue: string | null | undefined): boolean {
  const raw = (seedValue ?? "").trim();
  return raw === "" || attachmentOnlyNames(raw) !== null;
}

/** The thread patch that makes `artifact` the case's subject, or `null`. Fails closed. */
export function subjectPatch(seedValue: string | null | undefined, artifact: Artifact): SubjectPatch | null {
  if (!caseLacksSubject(seedValue)) return null;
  const kind = SELECTOR_KIND[artifact.kind.toLowerCase()];
  if (!kind) return null;
  const meta = (artifact.metadata ?? {}) as Record<string, unknown>;
  if (isClusterIneligible(artifact) || meta.conflict === true || meta.false_positive === true) return null;
  const value = artifact.value.trim();
  // The value must read as its own kind, exactly as a typed seed would.
  if (detectSeed(value)?.kind !== kind) return null;
  return { seed_value: value, seed_type: kind, title: formatThreadTitle(value) };
}

export const SET_SUBJECT_LABEL = "Set as case subject";
export const SET_SUBJECT_CONFIRM_TITLE = "Make this the subject of the case?";
export const SET_SUBJECT_CONFIRM_BODY =
  "This case has no subject yet — it was started from an upload, so nothing in it can be " +
  "linked to anyone.\n\n" +
  "Setting this selector as the subject re-keys the identity clusters on it, so rows that " +
  "share a selector with it can read as linked, and renames the case. It does not change " +
  "this row's confidence or any other evidence, and it does not start a run. The uploaded " +
  "file stays in the first message.";
