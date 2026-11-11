import { readProviderExport } from "@/lib/provider-export";
import { extractDisplaySeed, type SeedKind } from "@/lib/seed";
import { attachmentLabel, attachmentOnlyNames, parseUserMessage, typedTextBeforeAttachments } from "@/lib/attachments";

/**
 * The case's own name, when it says more than the selector does. A blank,
 * placeholder or selector-echo title returns null, and the header falls back to
 * the selector as its heading.
 *
 * A stored title that is a pasted provider export ("=== OATHNET INTELLIGENCE ===
 * Found via …") is not a name the analyst chose: the edge function wrote the raw
 * first 80 characters because `detectSeed` cannot read a multi-line block. It is
 * replaced by the title derived from the seed — the same `extractDisplaySeed`
 * reading the header's subtitle already uses. The stored title is untouched.
 */
export function humanCaseName(title: string | null, seedValue: string | null, seedDisplay: string): string | null {
  const stored = (title ?? "").trim();
  // An upload's raw "Attached files:" markdown is not a name; the header's seed
  // heading (the filename, from extractDisplaySeed) already says it.
  if (attachmentOnlyNames(stored)) return null;
  // Typed text followed by an upload: the edge stored both in the title. Only
  // the typed words can be a name.
  const t = typedTextBeforeAttachments(stored) ?? stored;
  if (!t || /^(new investigation|investigation|untitled)$/i.test(t)) return null;
  if (isPastedExport(t)) return exportSubjectTitle(seedValue) ?? exportSubjectTitle(t);
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
  if (norm(t) === norm(seedValue) || norm(t) === norm(seedDisplay)) return null;
  return t;
}

const KIND_LABELS: Partial<Record<SeedKind, string>> = {
  email: "Email",
  username: "Username",
  phone: "Phone",
  ip: "IP",
  domain: "Domain",
  url: "URL",
  crypto: "Crypto Wallet",
  address: "Address",
};

/** "=== …" opener, or export-shaped by `readProviderExport` (attribution, or a block of `key: value` lines). */
function isPastedExport(text: string): boolean {
  return /^\s*={3,}/.test(text) || readProviderExport(text) !== null;
}

/**
 * "Phone: <number>" / "Person: <name>" for text that is a pasted provider
 * export, read with the same `extractDisplaySeed` the header subtitle uses.
 * Null when `text` is not an export, or the export names no subject — so a
 * caller can fall through to its ordinary handling without a second parser.
 */
export function exportSubjectTitle(text: string | null | undefined): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const exported = readProviderExport(raw);
  if (!exported) return null;
  const d = extractDisplaySeed(raw);
  if (d.selector === "—") return null;
  if (d.kind !== "other") {
    const label = KIND_LABELS[d.kind];
    return label ? `${label}: ${d.selector}` : null;
  }
  // A name has no SeedKind; `extractDisplaySeed` carries it as "other". Only the
  // labelled name field counts — "other" is also its first-line fallback.
  return exported.pick?.kind === "name" ? `Person: ${d.selector}` : null;
}

/**
 * A thread's title for a dense list (sidebar, cases table, command palette).
 * Ordinary titles pass through byte-for-byte; a pasted-export title becomes the
 * seed-derived one, else "<Provider> export", else the title as stored.
 */
export function threadDisplayTitle(title: string | null | undefined, seedValue?: string | null): string {
  const stored = title ?? "";
  const files = attachmentOnlyNames(stored);
  if (files) return `Attachment: ${attachmentLabel(files)}`;
  // Typed text followed by an upload: print the typed words, never the block
  // (its link is a signed storage URL).
  const t = typedTextBeforeAttachments(stored) ?? stored;
  if (!isPastedExport(t)) return t;
  const derived = exportSubjectTitle(seedValue) ?? exportSubjectTitle(t);
  if (derived) return derived;
  const provider = readProviderExport(seedValue)?.provider ?? readProviderExport(t)?.provider;
  return provider ? `${provider} export` : t;
}

/**
 * The secondary text a list surface prints under a case's name: the seed the analyst
 * gave. A seed with an upload carries the composer's "Attached files:" block, whose
 * link is a 7-day SIGNED storage URL — a capability URL that must not be rendered into
 * a surface people screenshot or share. Print only the words the analyst typed; an
 * upload-only case has none, so the file already named in the label is not repeated.
 */
export function seedHint(seedValue: string | null | undefined): string {
  const raw = seedValue ?? "";
  const { body, attachments } = parseUserMessage(raw);
  return attachments.length > 0 ? body : raw;
}

/**
 * The name a case LIST row prints: `threadDisplayTitle` (an upload-only case reads
 * "Attachment: <file>", a pasted provider export reads its subject) with the
 * "Untitled case" fallback. Pass the seed when the list has it; without one an
 * upload-only title is still recognised from the title itself.
 */
export function caseListTitle(title: string | null | undefined, seedValue?: string | null): string {
  return threadDisplayTitle(title, seedValue).trim() || "Untitled case";
}
