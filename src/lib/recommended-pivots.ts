import { detectSeed } from "@/lib/seed";
import { isInfraDomain, type Pivot, type PivotType } from "@/lib/intel";
import { looksLikeReasoning, stripInlineTags, stripReasoningMarkup } from "@/lib/sanitize-agent-text";
import { isWellFormedTarget, type PivotTargetType } from "@/lib/pivot-target-shape";

export type RecommendedPivot = {
  label: string;
  actionLabel: string;
  detail: string;
  reason: string;
  priority: "high" | "medium" | "low";
  prompt: string;
  value: string;
  type: PivotType;
};

const HEADING_RE = /recommended\s+(?:next\s+)?pivots?/i;
const NEXT_HEADING_RE = /^(?:#{1,6}\s+|(?:summary|findings|network|sources|limitations|conclusion|next steps)\s*:?\s*$)/i;

/** A markdown table delimiter row: `|---|:--:|`. */
const TABLE_DELIM_RE = /^[\s|:_-]*-[\s|:_-]*$/;
/** A horizontal rule on its own line: `---`, `***`, `___`, `- - -`. */
const HR_RE = /^(?:[-*_][ \t]*){3,}$/;
/** A line that is entirely italic (`*note*`, `_note_`) — never a bullet ("* x") or bold ("**x**"). */
const ITALIC_NOTE_RE = /^([*_])(?![*_\s]).*[^*_\s]\1$/;

function cleanLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\*\*/g, "")
    .trim();
}

/**
 * Quotes, backticks and brackets are Markdown AROUND a selector, never part of
 * it. `[^\s@]` used to swallow them, so "`jane@uni.example`" became a target
 * WITH its backticks (measured 2026-10-01, spearheadlab case). An apostrophe
 * BETWEEN local-part characters is legal, though ("o'connor@…"): excluding it
 * outright extracted the different address "connor@…" (Codex P1 on #670).
 */
const EMAIL_RE = /[^\s@`'"()<>[\],;]+(?:'[^\s@`'"()<>[\],;]+)*@[^\s@`'"()<>[\],;]+\.[^\s@`'"()<>[\],;]+/i;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const USERNAME_RE = /@[a-z0-9_.-]{2,40}\b/i;
const URL_RE = /\bhttps?:\/\/[^\s)]+/i;
const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/i;
const PHONE_RE = /\b(?:\+?1[-.\s]*)?(?:\(?\d{3}\)?[-.\s]*)\d{3}[-.\s]*\d{4}\b/;
const PHONE_RE_G = new RegExp(PHONE_RE.source, "g");
/** A calendar date — digit-and-dash shaped, so detectSeed() reads it as a phone. */
const DATE_RE = /^(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})$/;
/** Words that make a bare, unseparated digit run read as a phone number. */
const PHONE_CONTEXT_RE = /\b(?:phone|tel|telephone|cell|cellphone|mobile|landline|sms|whatsapp|caller)\b/i;
const STREET_RE = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Place|Pl|Pkwy|Parkway)\b[^.;]*/i;
const WALLET_RE = /\b(?:0x[a-f0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{20,})\b/i;
const SECRET_RE = /\b(password|passcode|plaintext|secret|token|cookie|session|ssid|credential|hash|2fa|otp|cvv|ssn)\b/i;
const MINOR_RE = /\b(minor|underage|child|teen)\b/i;
const COLLISION_RE = /\b(excluded|collision|namesake|unrelated|wrong person|not the same person)\b/i;

/**
 * A line that NAMES the selector class and puts the value right after it:
 * "Corroborate username jdoe88 across platforms", "Check ip address
 * 203.0.113.44". Without this the value reads as the whole action clause
 * ("username jdoe88 across platforms"), which is neither a runnable selector
 * nor matchable against the tool log's already-searched keys.
 *
 * SINGLE-TOKEN KINDS ONLY. `name` is deliberately absent: a name is several
 * words, so "the name Jordan Vale" would be truncated to "Jordan".
 */
const KIND_LED_RE = /\b(username|handle|alias|email|domain|wallet|ip|phone)\s+(?:address\s+|number\s+|for\s+|of\s+|:\s*)?["\u2018\u2019'`@]?([^\s,;:"'`]+)/i;

const KIND_LED_TYPE: Record<string, PivotTargetType> = {
  username: "username", handle: "username", alias: "username",
  email: "email", domain: "domain", wallet: "wallet", ip: "ip", phone: "phone",
};

function compact(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;:]+$/, "").trim();
}

/**
 * Whether a phone-shaped value in `label` is plausibly a phone number and not
 * an id or a date. Measured case (2026-09-24): a scheme-less Apple Music link
 * produced a HIGH-priority "Check phone association <track id>" card for the
 * 10-digit catalogue id in its path — URL_RE needs `https?://`, so PHONE_RE
 * was the first pattern to claim the digits.
 *
 *  - never when the digits sit inside a path/query token (`/`, `=`, `#`, `?`);
 *  - never a date ("2023-02-02"), which detectSeed() otherwise calls a phone;
 *  - a NANP-shaped number (`+1…`, or 10 / 1+10 digits with no `+`) must have
 *    an area code and exchange starting 2–9, so `123…` / `180…` are not US
 *    numbers. Other lengths (7-digit local, national formats abroad) and
 *    non-`+1` international numbers keep their previous treatment;
 *  - a bare, unseparated digit run also needs the line to SAY phone. A
 *    formatted number ("925-642-7442", "(916) 555-0142") carries that signal
 *    in its own punctuation; a catalogue id carries none.
 */
export function isPlausiblePhone(value: string, label: string): boolean {
  const trimmed = value.trim();
  const tokenHoldingValue = label.split(/\s+/).find((token) => token.includes(trimmed));
  if (tokenHoldingValue && /[/=#?]/.test(tokenHoldingValue)) return false;
  if (DATE_RE.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  const nanpShaped = trimmed.startsWith("+1") ||
    (!trimmed.startsWith("+") && (digits.length === 10 || (digits.length === 11 && digits.startsWith("1"))));
  if (nanpShaped) {
    const national = digits.length === 11 ? digits.slice(1) : digits;
    if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return false;
  }
  const bare = /^\+?\d+$/.test(trimmed);
  return !bare || PHONE_CONTEXT_RE.test(label);
}

function firstPlausiblePhone(label: string): string | undefined {
  for (const match of label.matchAll(PHONE_RE_G)) {
    // `\b` cannot sit before "(", so "(916) 555-0199" matches as "916) 555-0199".
    const value = label[(match.index ?? 0) - 1] === "(" && /^\d{3}\)/.test(match[0]) ? `(${match[0]}` : match[0];
    if (isPlausiblePhone(value, label)) return value;
  }
  return undefined;
}

/**
 * An example is not an observation. Report prose hedges with "may contain the
 * student's university email (e.g., `jane@uni.example` or `@campus.example`)":
 * the address is the MODEL'S GUESS at a format. Parsed as a selector it became a
 * HIGH-priority "email" card with a Run button (measured 2026-10-01) — a breach
 * lookup on an address nobody observed, about a private person.
 *
 * So identifiers are never taken from an example clause: a parenthetical that
 * carries an example marker is dropped whole, and an unbracketed one is dropped
 * up to the next clause break. "i.e." is deliberately NOT a marker — it restates
 * the thing itself rather than offering a sample of it.
 */
const EXAMPLE_PAREN_RE = /\([^()]*\b(?:e\.\s?g\.|eg\.|for example|for instance|such as)[^()]*\)/gi;
// Stops at a clause break OR the end of the example's sentence (". " then a
// capital), so a real selector in the next sentence survives (Codex P2 on #670).
// No `i` flag (the capital in the lookahead must be a real capital), so the
// markers spell out their own case.
const EXAMPLE_CLAUSE_RE = /\b(?:[Ee]\.\s?[Gg]\.|[Ee][Gg]\.|[Ff]or example|[Ff]or instance|[Ss]uch as)(?:(?!\.\s+[A-Z])[^;—–)])*/g;

function withoutExamples(label: string): string {
  return label.replace(EXAMPLE_PAREN_RE, " ").replace(EXAMPLE_CLAUSE_RE, " ");
}

/**
 * The first domain that is a domain, not the host of a scheme-less URL. In
 * "`repo.example.edu/pub/2025/1234/...`" the subject is a PAGE; offering
 * "Review domain footprint repo.example.edu" pivots onto whoever hosts it.
 */
function firstBareDomain(label: string): string | undefined {
  for (const match of label.matchAll(new RegExp(DOMAIN_RE.source, "gi"))) {
    if (label[(match.index ?? 0) + match[0].length] !== "/") return match[0];
  }
  return undefined;
}

function extractTarget(rawLabel: string): string {
  const label = withoutExamples(rawLabel);
  const directIdentifier =
    label.match(EMAIL_RE)?.[0] ??
    label.match(IPV4_RE)?.[0] ??
    label.match(URL_RE)?.[0] ??
    label.match(USERNAME_RE)?.[0] ??
    firstPlausiblePhone(label) ??
    label.match(STREET_RE)?.[0] ??
    label.match(WALLET_RE)?.[0] ??
    firstBareDomain(label);
  if (directIdentifier) return stripTrailingPunctuation(directIdentifier);

  // The line names its own selector class — take the token after it, but only
  // if that token is actually well-formed FOR that class, so "Verify email
  // ownership" does not yield the selector "ownership".
  const led = label.match(KIND_LED_RE);
  if (led) {
    const candidate = stripTrailingPunctuation(led[2]);
    const ledType = KIND_LED_TYPE[led[1].toLowerCase()];
    if (ledType && isWellFormedTarget(ledType, candidate)) return candidate;
  }

  // Two additions here, both of which decide whether a pivot can EVER be marked
  // already-run. `computePivots` keys "have we searched this?" on
  // `normalizeTarget(value)` and compares it against tool-log selectors, so any
  // prose the parser leaves in `value` makes that comparison unmatchable —
  // the pivot stays `status: "new"` forever and Chat's Next Steps re-offers it
  // on every render, no matter how deep the investigation has gone.
  //
  //  1. `(?:lead|leads)\s*[:—–-]?` — "Review lead: hawkcapo" captured
  //     "lead: hawkcapo", so the key was "lead hawkcapo" and no selector could
  //     ever equal it. This is a report vocabulary the model uses constantly.
  //  2. `-` in the terminator — "hawkcapo - YouTube channel" is one entity plus
  //     a descriptor. Only a SPACED hyphen terminates, so hyphenated identifiers
  //     ("hawk-capo", "Jean-Luc") are untouched.
  const action = label.match(
    /^(?:investigate|pivot on|verify|cross-reference|check|review|corroborate|confirm|compare)\s+(?:(?:lead|leads)\s*[:—–-]?\s*)?(.+?)(?:\s+[—–-]\s+|\s+\b(?:with|against|via|using|through|from)\b|$)/i,
  )?.[1];
  return stripTrailingPunctuation(
    (action ?? label)
      .replace(/^(?:excluded collision|collision|excluded)\s+/i, "")
      .replace(/['’]s\b.*$/i, "")
      .replace(/^["'`]|["'`]$/g, "")
      .trim(),
  );
}

function isAddressLike(value: string, label: string): boolean {
  return STREET_RE.test(value) || /\b(address|assessor|property|parcel|tax)\b/i.test(label);
}

function priorityForRecommendation(label: string, value: string, type: PivotType): RecommendedPivot["priority"] {
  const text = `${label} ${value}`.toLowerCase();
  if (
    type === "email" ||
    type === "phone" ||
    type === "domain" ||
    /\bofficial|assessor|property|tax|court|record|registry|breach|correlat|verify\b/.test(text)
  ) return "high";
  if (type === "name" || type === "username" || /\bsocial|platform|profile|source|archive\b/.test(text)) return "medium";
  return "low";
}

function pivotType(value: string): PivotType {
  const kind = detectSeed(value)?.kind;
  if (kind === "crypto") return "wallet";
  // "address" has no PivotType of its own — isAddressLike() below already
  // gives an address-shaped value its own action label ("Corroborate
  // address") and priorityForRecommendation() already favors
  // property/assessor/parcel language independent of `type`, so folding it
  // into the generic "name" lead type here doesn't lose that behavior.
  if (kind === "other" || kind === "address" || !kind) return "name";
  return kind;
}

function isBlockedRecommendation(label: string, value: string): boolean {
  if (!value) return true;
  if (SECRET_RE.test(label) || SECRET_RE.test(value)) return true;
  if (MINOR_RE.test(label) || MINOR_RE.test(value)) return true;
  return false;
}

function splitReason(label: string): { title: string; reason: string } {
  const [head, ...tail] = label.split(/\s+[—–-]\s+/);
  return {
    title: compact(head || label),
    reason: compact(tail.join(" — ")) || compact(head || label),
  };
}

function actionLabelForRecommendation(label: string, value: string, type: PivotType): string {
  if (COLLISION_RE.test(label)) return "Review excluded collision";
  // "Investigate", not "Verify … ownership": the run is a lookup (breach,
  // profile, provider) and none of those proves who owns the address.
  if (type === "email") return "Investigate email";
  if (type === "phone") return "Check phone association";
  if (isAddressLike(value, label)) return "Corroborate address";
  if (type === "domain" || type === "url") return "Review domain footprint";
  if (type === "ip") return "Check IP attribution";
  if (type === "username") return "Verify username linkage";
  if (/\b(property|assessor|court|registry|record|official)\b/i.test(label)) return "Corroborate with independent records";
  return "Review lead";
}

function detailForRecommendation(actionLabel: string, value: string, reason: string): string {
  const detail = compact(reason);
  if (!detail || detail.toLowerCase() === actionLabel.toLowerCase()) return value;
  if (detail.toLowerCase().includes(value.toLowerCase())) return detail;
  return `${value} · ${detail}`;
}

export function extractRecommendedPivots(text: string): RecommendedPivot[] {
  // Strip agent chain-of-thought before parsing: the report text can carry
  // <think>…</think> blocks (model reasoning), and the chat renderer removes
  // them but this parser previously read the raw text, so reasoning lines leaked
  // into Next Steps cards. Sanitize once here so cards never show it.
  const lines = stripReasoningMarkup(text).split(/\r?\n/);
  const start = lines.findIndex((line) => HEADING_RE.test(cleanLine(line)));
  if (start < 0) return [];

  const pivots: RecommendedPivot[] = [];
  const seen = new Set<string>();
  const body = lines.slice(start + 1);
  for (let i = 0; i < body.length; i++) {
    const raw = body[i].trim();
    if (!raw) continue;
    // Skip markdown table delimiter rows (|---|---|…) — table formatting, not
    // pivot data. Checked BEFORE the horizontal-rule test below, which a bare
    // "---" delimiter row would otherwise also match.
    if (raw.includes("|") && TABLE_DELIM_RE.test(raw)) continue;
    // A horizontal rule ENDS the section. It used to be skipped like a table
    // delimiter, so whatever followed it — measured 2026-09-25: the report's
    // closing "*Investigation conducted by …*" footer — was parsed as a pivot
    // and rendered as a "Suggestion needs repair" card on every run. A rule
    // before any pivot has been read is still skipped, so "## Pivots\n---\n- …"
    // keeps working.
    if (HR_RE.test(raw)) {
      if (pivots.length > 0) break;
      continue;
    }
    // A line that is entirely italic is a note or a footer, never an action.
    if (ITALIC_NOTE_RE.test(raw)) continue;
    let line: string;
    if (raw.startsWith("|")) {
      // A pivots TABLE: read it by cell. The raw row used to be parsed whole,
      // so the header row ("| Pivot | Rationale | Tool |") and every
      // "| action | reason | tool |" row became a pivot whose target was the
      // entire row — rejected downstream as "a Markdown table cell" and shown
      // to the analyst as a broken card. First cell = the pivot, second = why.
      const next = body.slice(i + 1).find((l) => l.trim());
      if (next && TABLE_DELIM_RE.test(next.trim())) continue; // header row
      const cells = raw.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => cleanLine(c));
      if (!cells[0]) continue;
      line = cells[1] ? `${cells[0]} — ${cells[1]}` : cells[0];
    } else {
      line = cleanLine(raw);
    }
    if (!line) continue;
    if (NEXT_HEADING_RE.test(line)) break;
    // Defense-in-depth: drop any first-person reasoning line that survived
    // block stripping (e.g. a malformed/unterminated think block).
    if (looksLikeReasoning(line)) continue;
    // Verb list kept in sync with extractTarget()'s — a pivot line that happens
    // to end with ":" (e.g. "Corroborate the PO Box:") must not be mistaken for a
    // section heading and stop extraction early.
    if (line.endsWith(":") && !/^(?:investigate|pivot|verify|cross-reference|check|review|corroborate|confirm|compare)\b/i.test(line)) break;

    const value = extractTarget(line);
    const key = line.toLowerCase();
    if (seen.has(key) || isBlockedRecommendation(line, value)) continue;
    seen.add(key);
    const split = splitReason(line);
    const type = pivotType(value);
    // detectSeed() calls any 7+ char run of digits and dashes a phone, so an id
    // or a date that reached `value` through the action-clause fallback
    // ("Check 4155550142 — listing id", "Check 2023-02-02 — join date") would
    // still become a phone pivot. Not a runnable selector — drop it.
    if (type === "phone" && !isPlausiblePhone(value, line)) continue;
    // Report-recommended domains that are OSINT source infrastructure
    // (linkedin.com, bizfileonline.sos.ca.gov, opencorporates.com…) bypass
    // buildPivots' filter, so drop them here too — they are never actionable
    // "Review domain footprint" pivots.
    if ((type === "domain" || type === "url") && isInfraDomain(value)) continue;
    const priority = priorityForRecommendation(line, value, type);
    const actionLabel = actionLabelForRecommendation(line, value, type);
    const reason = stripInlineTags(split.reason);
    const detail = stripInlineTags(detailForRecommendation(actionLabel, value, reason));
    pivots.push({
      label: stripInlineTags(line),
      actionLabel,
      detail,
      reason,
      priority,
      prompt: `Run this ${priority}-priority pivot.\n\nAction: ${actionLabel}\nTarget: ${value}\nType: ${type}\nReason: ${reason}\n\nUse authorized public-source methods only. Corroborate with independent sources when possible. RECORD every confirmed or observed finding via record_artifacts BEFORE you summarize — never report a case-graph change you have not recorded. Then give source URLs and a confidence tier for each finding.`,
      value,
      type,
    });
    if (pivots.length >= 6) break;
  }
  return pivots;
}

/**
 * Per-thread localStorage key for pivots the user explicitly skipped. This is
 * the ONLY pivot persistence: report recommendations are NEVER cached (they are
 * recomputed live from the latest assistant message via the
 * `swarmbot:report-pivots` event) so the Next-steps surface can never freeze.
 */
export function pivotSkipStorageKey(threadId: string): string {
  return `proximity:pivot-skip:${threadId}`;
}

export function toDisplayPivots(recommendations: RecommendedPivot[]): Pivot[] {
  return recommendations.map((recommendation, index) => ({
    value: recommendation.value,
    type: recommendation.type,
    why: recommendation.reason,
    source: "Report recommendation",
    sourceArtifactId: `report-pivot-${index}`,
    confidence: 0,
    fanout: recommendation.actionLabel,
    status: "new",
  }));
}
