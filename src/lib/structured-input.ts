/**
 * Stage 1 of structured-input handling: classify WHAT was submitted, before
 * anything tries to read a person out of it.
 *
 * This module imports NOTHING. It sits at the bottom of the graph next to
 * `artifact-exclusion.ts` so both the seed layer (`seed.ts`) and the report
 * layer (`intel.ts`) can consult it without importing each other.
 *
 * The staged model this exists to serve:
 *
 *     raw submitted input
 *       → classify structure            (here)
 *       → extract an explicit selector ONLY if defensible   (seed.ts)
 *       → retain the structured context separately          (DisplaySeed.structured)
 *       → report only what was actually established         (intel.ts)
 *
 * The failure this prevents is TWO-SIDED, and fixing only one side is how the
 * bug came back:
 *
 *   - A pasted JSON array once tokenized into the "subject"
 *     `module dhgate schemamodule`, which then led the report and labelled every
 *     un-named cluster. Structured text must yield NO name.
 *   - But it must also not silently VANISH. Dropping the payload leaves a report
 *     that looks like the analyst submitted nothing, which destroys the audit
 *     trail for what was actually asked.
 *
 * So: refuse to derive identity from it, and keep a provenance record of it.
 */

export type StructuredForm =
  | "json_object"
  | "json_array"
  | "json_like"
  | "markup"
  | "none";

export type StructuredInput = {
  /** `true` for every form except "none". The single gate other layers ask about. */
  structured: boolean;
  form: StructuredForm;
  /** Character length of the raw submission. Provenance, not analysis. */
  length: number;
  /**
   * Opened with `{`/`[` but did not parse. Truncated pastes are COMMON and must
   * be treated as structured anyway — a half-copied JSON blob is no more a
   * person's name than a complete one.
   */
  malformed: boolean;
  /** Top-level element count when it parsed. `null` when unknown/malformed. */
  recordCount: number | null;
  /** One line, safe to print, describing what was submitted. */
  summary: string;
};

/** HTML / XML element syntax. */
const MARKUP_RE = /<\/?[a-z][\w-]*(\s[^>]*)?>/i;
/** JSON/markup punctuation. Quotes and brackets — NOT commas (see below). */
const STRUCTURAL_PUNCT_RE = /[{}[\]"<>]/g;
const STRUCTURAL_PUNCT_FLOOR = 4;

const NONE: StructuredInput = {
  structured: false,
  form: "none",
  length: 0,
  malformed: false,
  recordCount: null,
  summary: "",
};

function describe(form: StructuredForm, recordCount: number | null, malformed: boolean, length: number): string {
  const base =
    form === "json_object" ? "JSON object"
    : form === "json_array" ? "JSON array"
    : form === "markup" ? "HTML/XML markup"
    : "JSON-like structured text";
  const count =
    recordCount === null ? ""
    : form === "json_array" ? ` (${recordCount} top-level element${recordCount === 1 ? "" : "s"})`
    : ` (${recordCount} top-level key${recordCount === 1 ? "" : "s"})`;
  const state = malformed ? ", malformed or truncated" : "";
  return `${base}${count}${state}, ${length} character${length === 1 ? "" : "s"}`;
}

/**
 * Classify a raw submitted string.
 *
 * Deliberately conservative about what counts as structural: commas are NOT,
 * because `John Smith, Sacramento, CA 95814` is a legitimate name-and-location
 * seed and must keep working as one.
 */
export function classifyStructuredInput(raw: string | null | undefined): StructuredInput {
  const t = (raw ?? "").trim();
  if (!t) return NONE;

  if (/^[[{]/.test(t)) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (parsed && typeof parsed === "object") {
        const isArray = Array.isArray(parsed);
        const form: StructuredForm = isArray ? "json_array" : "json_object";
        const recordCount = isArray
          ? (parsed as unknown[]).length
          : Object.keys(parsed as Record<string, unknown>).length;
        return {
          structured: true,
          form,
          length: t.length,
          malformed: false,
          recordCount,
          summary: describe(form, recordCount, false, t.length),
        };
      }
    } catch {
      // Truncated / malformed paste. Fall through to the shape check rather than
      // treating an unparseable blob as free text — that is the exact path by
      // which a half-copied payload became a person's name.
    }
    if (/["':]/.test(t)) {
      return {
        structured: true,
        form: "json_like",
        length: t.length,
        malformed: true,
        recordCount: null,
        summary: describe("json_like", null, true, t.length),
      };
    }
  }

  if (MARKUP_RE.test(t)) {
    return {
      structured: true,
      form: "markup",
      length: t.length,
      malformed: false,
      recordCount: null,
      summary: describe("markup", null, false, t.length),
    };
  }

  if ((t.match(STRUCTURAL_PUNCT_RE) ?? []).length >= STRUCTURAL_PUNCT_FLOOR) {
    return {
      structured: true,
      form: "json_like",
      length: t.length,
      malformed: false,
      recordCount: null,
      summary: describe("json_like", null, false, t.length),
    };
  }

  return { ...NONE, length: t.length };
}
