// attribution-check.ts — pre-report attribution guard (#15).
//
// Why this exists: in the Chris Nanos case the agent attributed
// `charn@comcast.net` to Chris Nanos, then corrected to Charlene Nanos (spouse)
// only AFTER the first report was written. `charn` = "Char[lene] N", not Chris.
// This guard runs BEFORE report attribution and flags emails/identifiers that
// don't plausibly belong to the subject, so the orchestrator can resolve the
// real owner (or mark it unverified) before it pollutes the dossier.
//
// Pure + deterministic. It NEVER changes confidence or status — it only emits
// advisory flags + reasons for the orchestrator/report layer to act on.

export interface SubjectProfile {
  /** Primary subject name, e.g. "Chris Nanos". */
  name: string;
  /** Known variants/aliases, e.g. ["Chris", "Christopher", "C. Nanos"]. */
  nameVariants?: string[];
  /** "M" | "F" | "U" if known. */
  gender?: string;
  city?: string;
}

export interface EmailLikeArtifact {
  /** The email (or local-part-bearing identifier). */
  value: string;
  metadata?: {
    /** Owner asserted by a provider/breach (e.g. AT&T billing name). */
    possible_owner?: string;
    owner?: string;
    full_name?: string;
    gender?: string;
    [k: string]: unknown;
  } | null;
}

export type AttributionVerdict = "ok" | "attribution_suspect" | "attribution_unverified";

export interface AttributionFinding {
  value: string;
  verdict: AttributionVerdict;
  reason: string;
  likely_owner?: string;
}

/** Normalize to lowercase alpha tokens. */
function tokens(s: string): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z\s.'-]/g, " ")
    .split(/[\s.'-]+/)
    .filter(Boolean);
}

function nameForms(subject: SubjectProfile): string[] {
  const forms = new Set<string>();
  for (const n of [subject.name, ...(subject.nameVariants ?? [])]) {
    for (const t of tokens(n)) if (t.length >= 2) forms.add(t);
  }
  return [...forms];
}

/**
 * Does the email local-part plausibly belong to the subject?
 * Matches a name token as a substring, OR the local-part starting with a
 * first-name token, OR first-initial + surname (e.g. "cnanos" for Chris Nanos).
 * Deliberately does NOT match a bare shared-surname compaction like "charn"
 * (Char + N) — that's the false-attribution class we want to catch.
 */
export function localPartMatchesSubject(localPart: string, subject: SubjectProfile): boolean {
  const lp = (localPart ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!lp) return false;
  const forms = nameForms(subject);
  const surnameTok = tokens(subject.name).slice(-1)[0] ?? "";
  for (const f of forms) {
    if (f.length < 3) continue;          // skip 2-char noise
    if (lp.includes(f)) return true;      // contains a full given/surname token
  }
  // first-initial + surname, e.g. "cnanos"
  const firstTok = tokens(subject.name)[0] ?? "";
  if (firstTok && surnameTok && lp.startsWith(firstTok[0] + surnameTok)) return true;
  return false;
}

export function checkEmailAttribution(
  subject: SubjectProfile,
  artifacts: EmailLikeArtifact[],
): AttributionFinding[] {
  const out: AttributionFinding[] = [];
  const subjGender = (subject.gender ?? "").toUpperCase();
  const subjForms = nameForms(subject);

  for (const a of artifacts) {
    const email = (a.value ?? "").trim();
    const localPart = email.split("@")[0] ?? email;
    if (!localPart) continue;
    const meta = a.metadata ?? {};
    const matches = localPartMatchesSubject(localPart, subject);

    const ownerRaw = String(meta.possible_owner ?? meta.owner ?? meta.full_name ?? "").trim();
    const ownerToks = tokens(ownerRaw);
    const ownerDiffers = ownerRaw.length > 0 && !ownerToks.some((t) => subjForms.includes(t));

    const aGender = String(meta.gender ?? "").toUpperCase();
    const genderMismatch = !!aGender && aGender !== "U" && !!subjGender && subjGender !== "U" && aGender !== subjGender;

    if (!matches && ownerDiffers) {
      out.push({
        value: email,
        verdict: "attribution_suspect",
        reason: `local-part "${localPart}" does not match subject name (${subject.name}); provider owner "${ownerRaw}" differs — likely shared/misattributed account`,
        likely_owner: ownerRaw,
      });
    } else if (genderMismatch) {
      out.push({
        value: email,
        verdict: "attribution_suspect",
        reason: `gender mismatch: source=${aGender}, subject=${subjGender} — likely spouse or different person`,
        likely_owner: ownerRaw || undefined,
      });
    } else if (!matches) {
      out.push({
        value: email,
        verdict: "attribution_unverified",
        reason: `local-part "${localPart}" does not match any known name variant of subject — attribution unverified`,
      });
    }
  }
  return out;
}
