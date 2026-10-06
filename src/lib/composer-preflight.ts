/**
 * composer-preflight.ts — what the investigation request will actually ask for.
 *
 * PURE. Parses the free-form request into a target, validates the analyst's
 * correction of its type, builds the one-line pre-submit summary, and compiles
 * the outgoing message.
 *
 * TWO HONESTY RULES:
 *
 * 1. Nothing is added unless the analyst changed something. A bare seed is sent
 *    byte-for-byte as typed, so seed detection, the investigation cache and the
 *    opening-phase gate see exactly what they always saw.
 *
 * 2. The only thing that can be added is a corrected target type, as ONE line.
 *    The `osint-agent` endpoint accepts `{ messages, threadId }` and nothing
 *    else, so a correction has to travel as text — and a type the agent never
 *    sees would be a control that silently does nothing.
 *
 * The advisory "Scope & controls" panel (objective, scope, exclusions, evidence
 * standard, depth) was removed 2026-09-14. It enforced nothing, and its
 * `— Scope & controls (analyst instructions) —` block was concatenated into the
 * stored seed and then truncated into the Timeline and Activity Log.
 */
import { readProviderExport } from "@/lib/provider-export";
import { detectSeed, extractDisplaySeed, type SeedKind } from "@/lib/seed";

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
  /** The analyst's correction of the detected target type, if any. */
  targetKind: SeedKind | null;
}

export const DEFAULT_CONTROLS: PreflightControls = { targetKind: null };

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
  errors: { target?: string };
  /** Nothing typed and nothing attached: the empty state, not an error. */
  empty: boolean;
  canSubmit: boolean;
  /** The analyst corrected the target type — so the message carries one extra line. */
  customized: boolean;
  summary: { target: string };
  /** The exact text that will be sent. */
  message: string;
}

/** Shapes a chosen target type must match. Kinds without a strict shape are not checked. */
const KIND_SHAPE: Partial<Record<SeedKind, RegExp>> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  ip: /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,39}$/i,
  url: /^https?:\/\/\S+$/i,
  domain: /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i,
  phone: /^\+?[\d\s().-]{7,24}$/,
  crypto: /^[A-Za-z0-9]{20,100}$/,
};

export function evaluatePreflight(input: PreflightInput): PreflightResult {
  const text = input.text.trim();
  const c = input.controls;
  const empty = !text && input.attachments === 0;
  // The whole request as one selector first (a bare seed); otherwise the
  // strongest selector inside the prose — "j.harker@… — who owns this?" — the
  // same extraction the case header uses to title a thread. For a pasted
  // provider export that is the subject's labelled field, never the provider's
  // own domain (see provider-export.ts).
  let detected: { raw: string; kind: SeedKind } | null = null;
  // An export with no email/phone/handle field: the free-text target is what
  // was read out of it (a person's name), never the "=== … ===" header line.
  let exportedText: string | null = null;
  if (text) {
    const direct = detectSeed(text);
    if (direct && direct.kind !== "other") detected = { raw: direct.raw, kind: direct.kind };
    else {
      const extracted = extractDisplaySeed(text, null);
      if (extracted.kind !== "other") detected = { raw: extracted.selector, kind: extracted.kind };
      else {
        const exp = readProviderExport(text);
        if (exp && (exp.pick || exp.scrubbed !== text) && extracted.selector !== "—") exportedText = extracted.selector;
      }
    }
  }
  const detectedKind = detected?.kind ?? null;
  const kind: SeedKind = c.targetKind ?? detectedKind ?? "other";
  // With nothing detected, the request itself is the (free-text) target; an
  // analyst-chosen type then applies to its first token.
  const value = detected?.raw ?? exportedText ?? (text ? (c.targetKind ? text.split(/\s+/)[0] : text.slice(0, 80)) : "");
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

  // Re-selecting the type that was already detected is not a correction.
  const customized = Boolean(target?.corrected);
  const canSubmit = !empty && !errors.target;
  const message = customized && target
    ? `${text}\n\nTarget: ${target.value} (${KIND_LABEL[target.kind].toLowerCase()})`
    : text;

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
    },
    message,
  };
}
