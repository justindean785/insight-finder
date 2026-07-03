import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  clusterDisplayId,
  isAsciiSafe,
  sanitizeValueForLabel,
  isCollisionArtifact,
  isReservedNumber,
  reservedNumberAnnotation,
  isSourceDiscrepancy,
  reportDisplayKind,
  bucketQualifiesAsCluster,
  sweepRouteQuality,
  dedupeBreachDatasets,
} from "@/lib/report-hygiene";

function art(partial: Partial<Artifact> & { kind: string; value: string }): Artifact {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    kind: partial.kind,
    value: partial.value,
    source: partial.source ?? null,
    confidence: partial.confidence ?? 50,
    created_at: partial.created_at ?? "2026-06-19T00:00:00.000Z",
    metadata: partial.metadata ?? {},
  } as Artifact;
}

// ---------------------------------------------------------------------------
// #1 — Cluster IDs: deterministic, ASCII-safe, stable.
// ---------------------------------------------------------------------------
describe("#1 cluster IDs", () => {
  it("are stable and zero-padded", () => {
    expect(clusterDisplayId(0)).toBe("C001");
    expect(clusterDisplayId(25)).toBe("C026");
    expect(clusterDisplayId(60)).toBe("C061");
    expect(clusterDisplayId(998)).toBe("C999");
  });

  it("emit NO non-printable/control/unicode-garbage characters for any index", () => {
    // The old String.fromCharCode(65+idx) produced '[', '\\', '^', '{', '~',
    // DEL and control chars past idx 25. Prove the new scheme never does.
    for (let i = 0; i < 500; i++) {
      const id = clusterDisplayId(i);
      expect(isAsciiSafe(id)).toBe(true);
      expect(/^C\d{3,}$/.test(id)).toBe(true);
      // explicitly reject the historical garbage set
      expect(/[[\\\]^_`{|}~]/.test(id)).toBe(false);
    }
  });

  it("handles bad input deterministically", () => {
    expect(clusterDisplayId(-5)).toBe("C001");
    expect(clusterDisplayId(NaN)).toBe("C001");
  });
});

// ---------------------------------------------------------------------------
// #3 — Strip "CONFIRMED" wording from values that aren't backend-CONFIRMED.
// ---------------------------------------------------------------------------
describe("#3 strip CONFIRMED wording", () => {
  it("removes promotional CONFIRMED text when the row is not CONFIRMED", () => {
    const out = sanitizeValueForLabel(
      "shortdeen28 → Nurideen Shabazz — CONFIRMED via two independent classes",
      false,
    );
    expect(out).not.toMatch(/CONFIRMED/i);
    expect(out).toContain("shortdeen28");
  });

  it("keeps the value intact when the row really is CONFIRMED", () => {
    const v = "alice@example.com — CONFIRMED via breach + github";
    expect(sanitizeValueForLabel(v, true)).toBe(v);
  });

  it("is a no-op when there is no CONFIRMED wording", () => {
    expect(sanitizeValueForLabel("deenthegreat", false)).toBe("deenthegreat");
  });

  it("does NOT strip ordinary lowercase prose use of 'confirmed' (live regression)", () => {
    // The exact live-captured mangled case: an `i`-flagged regex matched the
    // lowercase verb "confirmed" mid-sentence and deleted everything up to
    // the next period, turning "...191 confirmed in 5 breach corpora: Digido.ph, ..."
    // into "...191 .ph, ..." in the exported report.
    const v = "Phone +19165299191 confirmed in 5 breach corpora: Digido.ph, 1win, Wattpad, Verifications.io, National Public Data";
    expect(sanitizeValueForLabel(v, false)).toBe(v);
  });
});

// ---------------------------------------------------------------------------
// #6 — Collision detection.
// ---------------------------------------------------------------------------
describe("#6 collision quarantine", () => {
  it("flags excluded_collision kind", () => {
    expect(isCollisionArtifact(art({ kind: "excluded_collision", value: "x" }))).toBe(true);
  });
  it("flags metadata collision markers", () => {
    expect(isCollisionArtifact(art({ kind: "account_id", value: "x", metadata: { excluded_collision: true } }))).toBe(true);
    expect(isCollisionArtifact(art({ kind: "account_id", value: "x", metadata: { collision: true } }))).toBe(true);
  });
  it("does not flag normal artifacts", () => {
    expect(isCollisionArtifact(art({ kind: "email", value: "a@b.com" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #7 — Reserved/fictional phone numbers.
// ---------------------------------------------------------------------------
describe("#7 reserved number rendering", () => {
  it("detects reserved numbers and produces a non-actionable annotation", () => {
    const a = art({ kind: "phone", value: "786-555-0179", metadata: { reserved_number: true, reserved_reason: "555-01xx is the NANPA fiction/example range" } });
    expect(isReservedNumber(a)).toBe(true);
    const note = reservedNumberAnnotation(a);
    expect(note).toMatch(/non-actionable/i);
    expect(note).toMatch(/NANPA/);
  });
  it("returns null annotation for normal numbers", () => {
    expect(reservedNumberAnnotation(art({ kind: "phone", value: "813-555-1234" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #8 — Legal vs source-discrepancy kind.
// ---------------------------------------------------------------------------
describe("#8 source-discrepancy display kind", () => {
  it("reclassifies a bond discrepancy legal_record to source_conflict", () => {
    const a = art({ kind: "legal_record", value: "Bond: $2,500 set (Local 10) vs 'to be set' (TMZ) — discrepancy noted" });
    expect(isSourceDiscrepancy(a)).toBe(true);
    expect(reportDisplayKind(a)).toBe("source_conflict");
  });
  it("keeps a genuine arrest record as legal_record (conservative, not promoted)", () => {
    const a = art({ kind: "legal_record", value: "Miami Beach arrest — attempted strongarm robbery charge" });
    expect(isSourceDiscrepancy(a)).toBe(false);
    expect(reportDisplayKind(a)).toBe("legal_record");
  });
  it("does not touch non-legal kinds", () => {
    expect(reportDisplayKind(art({ kind: "email", value: "a vs b" }))).toBe("email");
  });
});

// ---------------------------------------------------------------------------
// #2 — Cluster-explosion guard.
// ---------------------------------------------------------------------------
describe("#2 cluster qualification", () => {
  it("qualifies any multi-artifact (merged) bucket", () => {
    expect(bucketQualifiesAsCluster([art({ kind: "account_id", value: "x" }), art({ kind: "account_id", value: "y" })])).toBe(true);
  });
  it("qualifies a lone name even with no selector key", () => {
    expect(bucketQualifiesAsCluster([art({ kind: "name", value: "Jane Doe" })], new Set())).toBe(true);
  });
  it("qualifies a lone artifact carrying a durable selector (email/handle key)", () => {
    expect(bucketQualifiesAsCluster([art({ kind: "email", value: "a@b.com" })], new Set(["email:a@b.com"]))).toBe(true);
    // a social_profile carrying metadata.handle is anchored via its handle key
    expect(bucketQualifiesAsCluster([art({ kind: "social_profile", value: "https://ig/@deem", source: "instagram" })], new Set(["handle:deem"]))).toBe(true);
  });
  it("does NOT qualify a lone account-existence check with no selector key", () => {
    expect(bucketQualifiesAsCluster([art({ kind: "account_id", value: "Xbox Gamertag: nurideen28", source: "username_sweep (HTTP 200)" })], new Set())).toBe(false);
  });
  it("does NOT qualify a lone sweep-only handle, but DOES qualify a corroborated one", () => {
    expect(bucketQualifiesAsCluster([art({ kind: "username", value: "nurideen28", source: "username_sweep" })], new Set(["handle:nurideen28"]))).toBe(false);
    expect(bucketQualifiesAsCluster([art({ kind: "username", value: "deenthegreat", source: "socialfetch_lookup (Instagram)" })], new Set(["handle:deenthegreat"]))).toBe(true);
  });
  it("does NOT qualify lone breach/other singletons with no selector", () => {
    expect(bucketQualifiesAsCluster([art({ kind: "breach_exposure", value: "Mathway breach" })], new Set())).toBe(false);
    expect(bucketQualifiesAsCluster([art({ kind: "other", value: "password pattern" })], new Set())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #5 — Sweep route-quality classification (NOT wired to canonical labels).
// ---------------------------------------------------------------------------
describe("#5 sweep route quality (classification only)", () => {
  it("classifies HTTP-200-but-no-content as route_only", () => {
    expect(sweepRouteQuality(art({ kind: "account_id", value: "Twitch: x", source: "username_sweep (HTTP 200 but no content retrieved)" }))).toBe("route_only");
    expect(sweepRouteQuality(art({ kind: "account_id", value: "HackTheBox x", source: "username_sweep (200 but profile returned 404)" }))).toBe("route_only");
    expect(sweepRouteQuality(art({ kind: "account_id", value: "HackerRank x", source: "username_sweep (202)" }))).toBe("route_only");
  });
  it("classifies a profile-content hit as content", () => {
    expect(sweepRouteQuality(art({ kind: "account_id", value: "Behance — bio + avatar", metadata: { profile_content: true } }))).toBe("content");
  });
});

// ---------------------------------------------------------------------------
// #6 — Conservative breach-dataset dedup.
// ---------------------------------------------------------------------------
describe("#6 dedupeBreachDatasets", () => {
  const SRC = "deepfind_email_breach+serus_darkweb_scan";

  it("collapses the two Synthient name variants (same source/count/year) to one", () => {
    const a = art({ id: "weak", kind: "weak_lead", value: "Synthient Credential Stuffing Threat Data (1.9B records, April 2025)", source: SRC });
    const b = art({ id: "exp", kind: "breach_exposure", value: "Synthient Credential Stuffing 2025 (1.9B)", source: SRC, metadata: { breach_date: "2025-04" } });
    const out = dedupeBreachDatasets([a, b]);
    expect(out).toHaveLength(1);
    // The richer breach_exposure row survives, not the weak_lead.
    expect(out[0].id).toBe("exp");
  });

  it("keeps genuinely different breaches separate (different count + year)", () => {
    const synthient = art({ kind: "breach_exposure", value: "Synthient Credential Stuffing 2025 (1.9B)", source: SRC });
    const pdl = art({ kind: "breach_exposure", value: "PDL (People Data Labs) 2019 - enrichment database", source: SRC });
    const imavex = art({ kind: "breach_exposure", value: "Imavex 2021", source: SRC });
    const out = dedupeBreachDatasets([synthient, pdl, imavex]);
    expect(out).toHaveLength(3);
  });

  it("does NOT collapse same dataset name across different source pairs", () => {
    const a = art({ kind: "breach_exposure", value: "Synthient Credential Stuffing 2025 (1.9B)", source: "deepfind_email_breach+serus_darkweb_scan" });
    const b = art({ kind: "breach_exposure", value: "Synthient Credential Stuffing 2025 (1.9B)", source: "some_other_tool" });
    expect(dedupeBreachDatasets([a, b])).toHaveLength(2);
  });

  it("does NOT collapse on a shared number alone (no shared significant word)", () => {
    // Same source + same 1.9B + same year but unrelated datasets → must stay split.
    const a = art({ kind: "breach_exposure", value: "Synthient Credential Stuffing 2025 (1.9B)", source: SRC });
    const b = art({ kind: "breach_exposure", value: "Telegram Combolist 2025 (1.9B)", source: SRC });
    expect(dedupeBreachDatasets([a, b])).toHaveLength(2);
  });

  it("ignores non-breach kinds and rows lacking a count or year", () => {
    const email = art({ kind: "email", value: "x@att.net", source: SRC });
    const noCount = art({ kind: "breach_exposure", value: "Imavex 2021", source: SRC });
    const noYear = art({ kind: "breach_exposure", value: "Some Dump (1.9B)", source: SRC });
    const out = dedupeBreachDatasets([email, noCount, noYear]);
    expect(out).toHaveLength(3);
  });
});
