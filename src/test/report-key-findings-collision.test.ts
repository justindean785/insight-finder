/**
 * An analyst-attested EXCLUSION ("this namesake is not the subject") must not
 * lead Key Findings. Production export 2026-09-20 (seed lildee808): the only
 * row under "Key Findings — leads" was the excluded Chicago-rapper collision,
 * because it was the single analyst-confirmed artifact. It belongs in the
 * Collision section, which already lists it.
 */
import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildReportMarkdown } from "@/lib/intel";

function art(p: Partial<Artifact> & { id: string; kind: string; value: string }): Artifact {
  return {
    id: p.id,
    kind: p.kind,
    value: p.value,
    confidence: p.confidence ?? 55,
    source: p.source ?? "minimax_web_search",
    created_at: p.created_at ?? "2026-09-20T12:00:00Z",
    metadata: p.metadata ?? null,
  };
}

const COLLISION = art({
  id: "col", kind: "excluded_collision", confidence: 15, source: "gemini_deep_dork",
  value: "Chicago drill rapper Lil Dee 808 - same-name collision candidate",
  metadata: { status: "excluded", excluded_collision: true, reason: "different handle, different city" },
});
const EMAIL = art({ id: "em", kind: "email", value: "subject@example.com", confidence: 60, source: "oathnet_lookup", metadata: { source_category: ["breach"] } });

function section(md: string, heading: RegExp): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("Key Findings excludes analyst-attested collisions", () => {
  it("the attested exclusion is not a Key Finding, and still appears in the Collision section", () => {
    const md = buildReportMarkdown({
      seedValue: "lildee808", seedType: "username",
      artifacts: [COLLISION, EMAIL],
      reviews: { col: "confirmed" },
    });
    const key = section(md, /^## Key Findings/);
    expect(key).toBeTruthy();
    expect(key).not.toContain("Chicago drill rapper");
    const collisions = section(md, /^## Collision/);
    expect(collisions).toContain("Chicago drill rapper");
  });
});
