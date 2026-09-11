/**
 * composer-preflight.ts — what the investigation request will actually ask for.
 *
 * PURE. Parses the free-form request into a target, validates the parts the
 * analyst supplied, builds the one-line pre-submit summary, and compiles the
 * outgoing message.
 *
 * TWO HONESTY RULES:
 *
 * 1. The controls are ADVISORY. The `osint-agent` endpoint accepts
 *    `{ messages, threadId }` and nothing else — there is no depth, scope or
 *    budget parameter. So Scope & controls travel as written instructions
 *    appended to the message, the agent reads them like any other instruction,
 *    and the server's own per-run caps are what is actually enforced. The UI
 *    says exactly that.
 *
 * 2. Nothing is added unless the analyst changed it. A bare seed is sent
 *    byte-for-byte as typed, so seed detection, the investigation cache and
 *    the opening-phase gate see exactly what they always saw.
 */
import { detectSeed, extractDisplaySeed, type SeedKind } from "@/lib/seed";

export type DepthPreset = "quick" | "standard" | "deep";
export type ScopePreset = "public" | "public_breach" | "public_no_sensitive";

export const EVIDENCE_STANDARD = [
  { key: "urls", label: "Source URLs" },
  { key: "utc", label: "UTC capture time" },
  { key: "tier", label: "T1–T6 source tier" },
  { key: "corroboration", label: "Independent corroboration" },
  { key: "unknowns", label: "Explicit unknowns" },
] as const;
export type EvidenceStandardKey = (typeof EVIDENCE_STANDARD)[number]["key"];

export const SCOPE_LABEL: Record<ScopePreset, string> = {
  public: "Public sources",
  public_breach: "Public sources and breach corpora",
  public_no_sensitive: "Public sources, excluding breach and broker data",
};

export const DEPTH_LABEL: Record<DepthPreset, string> = {
  quick: "Quick",
  standard: "Standard",
  deep: "Deep",
};

const DEPTH_INSTRUCTION: Record<DepthPreset, string> = {
  quick: "Quick pass — the highest-value lookups only; stop early once the target is characterised.",
  standard: "Standard depth.",
  deep: "Deep pass — follow corroborating pivots further before reporting.",
};

export const KIND_LABEL: Record<SeedKind, string> = {
  email: "Email",
  username: "Username",
  phone: "Phone",
  ip: "IP address",
  domain: "Domain",
  url: "URL",
  crypto: "Wallet",
  address: "Address",
  other: "Other",
};

export interface PreflightControls {
  objective: string;
  scope: ScopePreset;
  exclusions: string;
  evidence: EvidenceStandardKey[];
  depth: DepthPreset;
  /** The analyst's correction of the detected target type, if any. */
  targetKind: SeedKind | null;
}

export const DEFAULT_CONTROLS: PreflightControls = {
  objective: "",
  scope: "public",
  exclusions: "",
  evidence: EVIDENCE_STANDARD.map((e) => e.key),
  depth: "standard",
  targetKind: null,
};

export interface PreflightInput {
  text: string;
  attachments: number;
  /** The case already has a target (an earlier message ran). A follow-up needs no new one. */
  isFollowUp: boolean;
  controls: PreflightControls;
}

export interface PreflightResult {
  /**
   * The parsed target. `freeText` means no selector was found — a person's
   * name, a description — which is a legitimate request: the product runs
   * name-based investigations and `detectSeed` has no "name" kind.
   */
  target: { value: string; kind: SeedKind; corrected: boolean; freeText: boolean } | null;
  errors: { target?: string; objective?: string };
  /** Nothing typed and nothing attached: the empty state, not an error. */
  empty: boolean;
  canSubmit: boolean;
  /** Any control differs from its default — so the message carries instructions. */
  customized: boolean;
  summary: { target: string; objective: string; scope: string; depth: string; budget: string };
  /** The exact text that will be sent. */
  message: string;
}

const PLACEHOLDER = /^(?:tbd|n\/?a|none|todo|test|asdf|x+|\.+|-+|\?+)$/i;

/** Shapes a chosen target type must match. Kinds without a strict shape are not checked. */
const KIND_SHAPE: Partial<Record<SeedKind, RegExp>> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  ip: /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,39}$/i,
  url: /^https?:\/\/\S+$/i,
  domain: /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i,
  phone: /^\+?[\d\s().-]{7,24}$/,
  crypto: /^[A-Za-z0-9]{20,100}$/,
};

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export function isCustomized(c: PreflightControls): boolean {
  return (
    c.objective.trim() !== "" ||
    c.scope !== DEFAULT_CONTROLS.scope ||
    c.exclusions.trim() !== "" ||
    !sameSet(c.evidence, DEFAULT_CONTROLS.evidence) ||
    c.depth !== DEFAULT_CONTROLS.depth ||
    c.targetKind !== null
  );
}

export function evaluatePreflight(input: PreflightInput): PreflightResult {
  const text = input.text.trim();
  const c = input.controls;
  const empty = !text && input.attachments === 0;
  // The whole request as one selector first (a bare seed); otherwise the
  // strongest selector inside the prose — "j.harker@… — who owns this?" — the
  // same extraction the case header uses to title a thread.
  let detected: { raw: string; kind: SeedKind } | null = null;
  if (text) {
    const direct = detectSeed(text);
    if (direct && direct.kind !== "other") detected = { raw: direct.raw, kind: direct.kind };
    else {
      const extracted = extractDisplaySeed(text, null);
      if (extracted.kind !== "other") detected = { raw: extracted.selector, kind: extracted.kind };
    }
  }
  const detectedKind = detected?.kind ?? null;
  const kind: SeedKind = c.targetKind ?? detectedKind ?? "other";
  // With nothing detected, the request itself is the (free-text) target; an
  // analyst-chosen type then applies to its first token.
  const value = detected?.raw ?? (text ? (c.targetKind ? text.split(/\s+/)[0] : text.slice(0, 80)) : "");
  const target = value
    ? { value, kind, corrected: c.targetKind !== null && c.targetKind !== detectedKind, freeText: !detected && !c.targetKind }
    : null;

  const errors: PreflightResult["errors"] = {};
  // A chosen type must match what was typed: "Email" over a request with no
  // email address in it would send the agent after the wrong thing.
  if (target && c.targetKind && c.targetKind !== detectedKind) {
    const shape = KIND_SHAPE[c.targetKind];
    if (shape && !shape.test(target.value)) {
      errors.target = `No ${KIND_LABEL[c.targetKind].toLowerCase()} found in the request. Check the target or change its type.`;
    }
  }
  const objective = c.objective.trim();
  if (objective) {
    const words = objective.split(/\s+/).filter(Boolean);
    if (PLACEHOLDER.test(objective) || objective.length < 8 || words.length < 2) {
      errors.objective = "State the question in a few words — for example, “Who controls this mailbox?”";
    } else if (target && objective.toLowerCase() === target.value.toLowerCase()) {
      errors.objective = "The objective repeats the target. Say what you need to know about it.";
    }
  }

  // Re-selecting the type that was already detected is not a customisation.
  const customized = isCustomized(target?.corrected ? c : { ...c, targetKind: null });
  const canSubmit = !empty && !errors.target && !errors.objective;

  const lines: string[] = [];
  if (customized) {
    lines.push("", "— Scope & controls (analyst instructions) —");
    if (target && target.corrected) lines.push(`Target: ${target.value} (${KIND_LABEL[target.kind].toLowerCase()})`);
    if (objective) lines.push(`Objective: ${objective}`);
    lines.push(`Authorized scope: ${SCOPE_LABEL[c.scope]}`);
    if (c.exclusions.trim()) lines.push(`Exclusions: ${c.exclusions.trim()}`);
    const standard = EVIDENCE_STANDARD.filter((e) => c.evidence.includes(e.key)).map((e) => e.label);
    lines.push(`Evidence standard: ${standard.length ? standard.join(", ") : "none specified"}`);
    lines.push(`Depth: ${DEPTH_INSTRUCTION[c.depth]}`);
  }
  const message = customized ? `${text}\n${lines.join("\n")}` : text;

  return {
    target,
    errors,
    empty,
    canSubmit,
    customized,
    summary: {
      target: target
        ? target.freeText ? `${target.value} (free text)` : `${target.value} (${KIND_LABEL[target.kind].toLowerCase()})`
        : input.isFollowUp ? "Current case target" : "Not set",
      objective: objective || "Agent default — identify and corroborate",
      scope: SCOPE_LABEL[c.scope],
      depth: DEPTH_LABEL[c.depth],
      budget: "Server per-run cap",
    },
    message,
  };
}
