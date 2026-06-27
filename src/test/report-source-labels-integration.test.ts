import { describe, it, expect } from "vitest";
import { buildReportMarkdown } from "@/lib/intel";

// Artifact shape mirroring intel.ts consumers (matches report-render-fixes.test.ts).
const artifact = (over: Partial<{ id: string; kind: string; value: string; source: string | null; confidence: number | null; created_at: string; metadata: Record<string, unknown> | null }> = {}) => ({
  id: over.id ?? "a1",
  thread_id: "t1",
  kind: over.kind ?? "email",
  value: over.value ?? "x@y.com",
  source: over.source ?? "breach_check",
  confidence: over.confidence ?? 60,
  created_at: over.created_at ?? "2026-06-01T10:00:00Z",
  updated_at: over.created_at ?? "2026-06-01T10:00:00Z",
  metadata: over.metadata ?? null,
  label: "VERIFY" as const,
  is_key: false,
  is_dismissed: false,
  notes: null,
  review_state: null,
  group: "contact" as const,
});

// Damien-style regression fixture: the exact risky mix — a compound breach
// source chain, a legal/criminal record, a contradiction, and an excluded
// collision. The report must humanize sources while keeping uncertainty and
// never turning the collision into a confirmed identity link.
function damienMarkdown(): string {
  return buildReportMarkdown({
    seedValue: "damienbunnyobrien@gmail.com",
    seedType: "email",
    artifacts: [
      artifact({
        id: "breach", kind: "breach", confidence: 65,
        value: "damienbunnyobrien@gmail.com in Mindjolt breach (2019, 28.4M records)",
        source: "breach_check+oathnet_lookup+serus_darkweb_scan+bosint_email_lookup+deepfind_email_breach",
      }),
      artifact({
        id: "legal", kind: "legal_record", confidence: 55,
        value: "Genesee County criminal case — Damien O'Brien (second-degree murder)",
        source: "minimax_web_search+gemini_deep_dork",
      }),
      artifact({
        id: "collision", kind: "excluded_collision", confidence: 10,
        value: "UK street magician Damien O'Brien — same name, different person",
        source: "minimax_web_search",
        metadata: { different_person: true, collision: true },
      }),
      artifact({
        id: "conflict", kind: "phone", confidence: 40, value: "9258139324",
        source: "username_sweep",
        metadata: { conflict_note: "Different name/address than the seed cluster" },
      }),
    ],
  });
}

const RAW_SLUG_RE = /\b[a-z0-9]+_[a-z0-9]+(?:_[a-z0-9]+)*\b/; // any snake_case tool id

describe("report markdown — source labels are humanized (P1-2)", () => {
  it("does not leak raw tool IDs into the report body", () => {
    const md = damienMarkdown();
    for (const slug of [
      "oathnet_lookup", "serus_darkweb_scan", "bosint_email_lookup",
      "deepfind_email_breach", "minimax_web_search", "gemini_deep_dork",
      "username_sweep", "breach_check",
    ]) {
      expect(md, `raw slug ${slug} must not appear`).not.toContain(slug);
    }
  });

  it("shows readable source labels instead", () => {
    const md = damienMarkdown();
    expect(md).toContain("breach/profile lookup");
    expect(md).toContain("dark-web scan");
    expect(md).toContain("web search");
    expect(md).toContain("AI-assisted deep search");
  });

  it("never emits chain-of-thought / XML-ish reasoning tags", () => {
    const md = damienMarkdown();
    expect(md).not.toContain("<think>");
    expect(md).not.toMatch(/<\/?think>/i);
  });

  it("preserves uncertainty and keeps the collision NOT a confirmed identity", () => {
    const md = damienMarkdown();
    // Collision section present and explicit that it does not belong to the subject.
    expect(md).toContain("## Collision / Likely Unrelated");
    expect(md).toMatch(/do NOT belong to the subject/i);
    // The criminal/legal record must not be promoted to a confirmed identity link.
    expect(md).not.toMatch(/criminal[^\n]*CONFIRMED|CONFIRMED[^\n]*criminal/i);
    // The weak/collision mix yields no fully-corroborated findings.
    expect(md).toContain("Key Findings");
    expect(md).toMatch(/No findings recorded yet|No fully-corroborated findings yet|Strongest uncorroborated leads/i);
  });

  it("the source portion of every 'via …' line carries no raw tool slug", () => {
    const md = damienMarkdown();
    // Only inspect the SOURCE text (after "via ", before the closing paren).
    // Artifact KINDS like `excluded_collision`/`legal_record` are out of scope.
    const viaSources = [...md.matchAll(/via ([^)]+)\)/g)].map((m) => m[1]);
    const offending = viaSources.filter((s) => RAW_SLUG_RE.test(s));
    expect(offending, `raw slug in source text:\n${offending.join("\n")}`).toHaveLength(0);
  });
});
