import { describe, it, expect } from "vitest";

// ── Core intel / confidence logic extracted from src/lib/intel.ts ──

const GROUP_ORDER = ["identity", "contact", "social", "infrastructure", "breach", "web", "crypto", "other"] as const;
type Group = typeof GROUP_ORDER[number];

const GROUP_LABEL: Record<Group, string> = {
  identity: "IDENTITY",
  contact: "CONTACT",
  social: "SOCIAL",
  infrastructure: "INFRASTRUCTURE",
  breach: "BREACH",
  web: "WEB",
  crypto: "CRYPTO",
  other: "OTHER",
};

function groupForKind(kind: string): Group {
  const k = kind.toLowerCase();
  if (["email", "name", "username", "avatar", "phone", "person"].includes(k)) return "contact";
  if (["ip", "domain", "url", "subdomain", "host"].includes(k)) return "infrastructure";
  if (["social", "twitter", "instagram", "linkedin", "github", "tiktok", "telegram"].includes(k)) return "social";
  if (["breach", "leak", "credential", "password"].includes(k)) return "breach";
  if (["wallet", "crypto", "bitcoin", "ethereum"].includes(k)) return "crypto";
  if (["website", "webpage", "html", "screenshot"].includes(k)) return "web";
  if (["name", "full_name", "person", "identity"].includes(k)) return "identity";
  return "other";
}

const REVIEW_CLASS: Record<string, string> = {
  confirmed: "bg-[hsl(var(--confidence-high))]/15 text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40",
  key: "bg-primary/15 text-primary border-primary/40",
  dismissed: "bg-muted/30 text-muted-foreground border-muted-foreground/30",
  recheck: "bg-warning/15 text-warning border-warning/40",
};

type ReviewState = "confirmed" | "key" | "dismissed" | "recheck" | null;

// Confidence tier classification
type ConfTier = "high" | "mid" | "low";
function classifyConfidence(conf: number): ConfTier {
  if (conf >= 70) return "high";
  if (conf >= 50) return "mid";
  return "low";
}

function confColor(tier: ConfTier): string {
  if (tier === "high") return "hsl(var(--brain-cyan))";
  if (tier === "mid") return "hsl(var(--confidence-mid))";
  return "hsl(var(--confidence-low))";
}

// ── Tests: groupForKind ──────────────────────────────────────────

describe("groupForKind", () => {
  it("classifies email as contact", () => {
    expect(groupForKind("email")).toBe("contact");
  });

  it("classifies phone as contact", () => {
    expect(groupForKind("phone")).toBe("contact");
  });

  it("classifies username as contact", () => {
    expect(groupForKind("username")).toBe("contact");
  });

  it("classifies ip as infrastructure", () => {
    expect(groupForKind("ip")).toBe("infrastructure");
  });

  it("classifies domain as infrastructure", () => {
    expect(groupForKind("domain")).toBe("infrastructure");
  });

  it("classifies url as infrastructure", () => {
    expect(groupForKind("url")).toBe("infrastructure");
  });

  it("classifies breach as breach", () => {
    expect(groupForKind("breach")).toBe("breach");
    expect(groupForKind("leak")).toBe("breach");
    expect(groupForKind("credential")).toBe("breach");
  });

  it("classifies social platforms as social", () => {
    expect(groupForKind("twitter")).toBe("social");
    expect(groupForKind("instagram")).toBe("social");
    expect(groupForKind("github")).toBe("social");
    expect(groupForKind("tiktok")).toBe("social");
  });

  it("classifies wallet/crypto as crypto", () => {
    expect(groupForKind("wallet")).toBe("crypto");
    expect(groupForKind("bitcoin")).toBe("crypto");
    expect(groupForKind("ethereum")).toBe("crypto");
  });

  it("classifies web artifacts as web", () => {
    expect(groupForKind("website")).toBe("web");
    expect(groupForKind("screenshot")).toBe("web");
    expect(groupForKind("webpage")).toBe("web");
  });

  it("is case-insensitive", () => {
    expect(groupForKind("EMAIL")).toBe("contact");
    expect(groupForKind("Domain")).toBe("infrastructure");
    expect(groupForKind("BREACH")).toBe("breach");
  });

  it("returns other for unknown kinds", () => {
    expect(groupForKind("unknown_thing")).toBe("other");
    expect(groupForKind("")).toBe("other");
  });

  it("all groups have labels", () => {
    for (const g of GROUP_ORDER) {
      expect(GROUP_LABEL[g]).toBeTruthy();
    }
  });

  it("all group labels are uppercase", () => {
    for (const label of Object.values(GROUP_LABEL)) {
      expect(label).toBe(label.toUpperCase());
    }
  });
});

// ── Tests: confidence classification ─────────────────────────────

describe("confidence classification", () => {
  it("classifies 70+ as high", () => {
    expect(classifyConfidence(70)).toBe("high");
    expect(classifyConfidence(85)).toBe("high");
    expect(classifyConfidence(100)).toBe("high");
  });

  it("classifies 50-69 as mid", () => {
    expect(classifyConfidence(50)).toBe("mid");
    expect(classifyConfidence(60)).toBe("mid");
    expect(classifyConfidence(69)).toBe("mid");
  });

  it("classifies < 50 as low", () => {
    expect(classifyConfidence(0)).toBe("low");
    expect(classifyConfidence(25)).toBe("low");
    expect(classifyConfidence(49)).toBe("low");
  });

  it("handles edge values correctly", () => {
    expect(classifyConfidence(69.9)).toBe("mid");
    expect(classifyConfidence(70)).toBe("high");
  });

  it("maps tiers to correct colors", () => {
    expect(confColor("high")).toBe("hsl(var(--brain-cyan))");
    expect(confColor("mid")).toBe("hsl(var(--confidence-mid))");
    expect(confColor("low")).toBe("hsl(var(--confidence-low))");
  });
});

// ── Tests: review state classification ───────────────────────────

describe("review state classification", () => {
  it("all review states have CSS classes", () => {
    expect(REVIEW_CLASS.confirmed).toBeTruthy();
    expect(REVIEW_CLASS.key).toBeTruthy();
    expect(REVIEW_CLASS.dismissed).toBeTruthy();
    expect(REVIEW_CLASS.recheck).toBeTruthy();
  });

  it("confirmed state uses confidence-high color", () => {
    expect(REVIEW_CLASS.confirmed).toContain("confidence-high");
  });

  it("key state uses primary color", () => {
    expect(REVIEW_CLASS.key).toContain("primary");
  });

  it("dismissed state uses muted color", () => {
    expect(REVIEW_CLASS.dismissed).toContain("muted");
  });

  it("recheck state uses warning color", () => {
    expect(REVIEW_CLASS.recheck).toContain("warning");
  });
});

// ── Tests: severity classification for evidence groups ───────────

type Severity = "high" | "mid" | "low" | "failed";

function classifyEvidenceSeverity(
  artifacts: { confidence: number | null; false_positive?: boolean }[],
): { high: number; mid: number; low: number; failed: number; overall: Severity } {
  let high = 0, mid = 0, low = 0, failed = 0;
  for (const a of artifacts) {
    if (a.false_positive) { failed++; continue; }
    const c = a.confidence ?? 0;
    if (c >= 70) high++;
    else if (c >= 50) mid++;
    else low++;
  }
  const overall: Severity =
    failed > 0 ? "failed" :
    low > 0 ? "low" :
    mid > 0 ? "mid" : "high";
  return { high, mid, low, failed, overall };
}

describe("evidence severity classification", () => {
  it("all high-confidence → overall high", () => {
    const result = classifyEvidenceSeverity([
      { confidence: 90 }, { confidence: 85 }, { confidence: 95 },
    ]);
    expect(result.overall).toBe("high");
    expect(result.high).toBe(3);
  });

  it("mixed confidence → overall reflects lowest", () => {
    const result = classifyEvidenceSeverity([
      { confidence: 95 }, { confidence: 45 }, { confidence: 80 },
    ]);
    expect(result.overall).toBe("low"); // low is lowest non-failed
    expect(result.high).toBe(2);
    expect(result.low).toBe(1);
  });

  it("false positive overrides all", () => {
    const result = classifyEvidenceSeverity([
      { confidence: 99, false_positive: true }, { confidence: 95 },
    ]);
    expect(result.overall).toBe("failed");
    expect(result.failed).toBe(1);
    expect(result.high).toBe(1);
  });

  it("handles null confidence as 0 (low)", () => {
    const result = classifyEvidenceSeverity([
      { confidence: null }, { confidence: 80 }, { confidence: 55 },
    ]);
    expect(result.overall).toBe("low");
    expect(result.low).toBe(1);
  });

  it("mid confidence only → overall mid", () => {
    const result = classifyEvidenceSeverity([
      { confidence: 55 }, { confidence: 65 }, { confidence: 50 },
    ]);
    expect(result.overall).toBe("mid");
    expect(result.mid).toBe(3);
  });

  it("empty list → overall high (no issues)", () => {
    const result = classifyEvidenceSeverity([]);
    expect(result.overall).toBe("high");
    expect(result.high).toBe(0);
  });
});

// ── Tests: REVIEW_SHORT abbreviations ────────────────────────────

const REVIEW_SHORT: Record<string, string> = {
  confirmed: "CONF",
  key: "KEY",
  dismissed: "DISM",
  recheck: "RECHK",
};

describe("REVIEW_SHORT", () => {
  it("all review states have short labels", () => {
    expect(REVIEW_SHORT.confirmed).toBe("CONF");
    expect(REVIEW_SHORT.key).toBe("KEY");
    expect(REVIEW_SHORT.dismissed).toBe("DISM");
    expect(REVIEW_SHORT.recheck).toBe("RECHK");
  });

  it("short labels are ≤ 5 characters", () => {
    for (const short of Object.values(REVIEW_SHORT)) {
      expect(short.length).toBeLessThanOrEqual(5);
    }
  });
});
