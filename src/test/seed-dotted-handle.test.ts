/**
 * seed-dotted-handle — a dotted handle is a username seed, not a domain.
 *
 * Measured on a production case (2026-11-10): the analyst typed a handle shaped
 * like `name.suffix` whose suffix is not a TLD. It was typed `domain`, the domain
 * tools had nothing to resolve, and the agent swept the shortened handle — a
 * common one owned by other people. Nothing linked to the seed.
 *
 * The edge mirror is detectSeedServer (validation.ts); its own test pins the
 * same table. Values here are synthetic.
 */
import { describe, it, expect } from "vitest";
import { detectSeed, extractDisplaySeed, formatThreadTitle } from "@/lib/seed";
import { endsInKnownTld, isKnownTld, IANA_TLDS } from "@/lib/tld-list";
import { buildIdentityClusters } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/** MUST match the table in supabase/tests/osint-agent/seed_dotted_handle_test.ts. */
const DOTTED_SEED_TABLE: Array<[input: string, kind: string, normalized: string]> = [
  ["sample.handle", "username", "sample.handle"],
  ["Sample.Handle", "username", "sample.handle"],
  ["first.last.priv", "username", "first.last.priv"],
  ["sample_one.x1", "username", "sample_one.x1"],
  ["@sample.handle", "username", "sample.handle"],
  ["example.com", "domain", "example.com"],
  ["sub.example.co.uk", "domain", "sub.example.co.uk"],
  ["sample.dev", "domain", "sample.dev"],
  ["example.invalid", "domain", "example.invalid"],
  ["host.internal", "domain", "host.internal"],
  ["xn--e1afmkfd.xn--p1ai", "domain", "xn--e1afmkfd.xn--p1ai"],
  ["203.0.113.57", "ip", "203.0.113.57"],
  ["report.pdf", "domain", "report.pdf"], // a file name keeps its old classification; it is not a handle
  ["sample_handle", "username", "sample_handle"],
];

describe("dotted handle seeds", () => {
  it("types by the last label: a real TLD is a domain, anything else is a handle", () => {
    for (const [input, kind, normalized] of DOTTED_SEED_TABLE) {
      const d = detectSeed(input);
      expect(d?.kind, input).toBe(kind);
      expect(d?.normalized, input).toBe(normalized);
    }
  });

  it("keeps the full dotted value as the handle", () => {
    expect(detectSeed("sample.handle")).toEqual({ kind: "username", raw: "sample.handle", normalized: "sample.handle" });
  });

  it("a dotted token too long or too odd to be a handle is `other`, never a domain", () => {
    expect(detectSeed(`${"a".repeat(41)}.handle`)?.kind).toBe("other");
  });

  it("the case header and the thread title read username", () => {
    expect(extractDisplaySeed("sample.handle", "domain")).toMatchObject({ selector: "sample.handle", kind: "username" });
    expect(formatThreadTitle("sample.handle")).toBe("Username: sample.handle");
    expect(formatThreadTitle("example.com")).toBe("Domain: example.com");
  });

  it("the TLD list is the IANA root zone plus the reserved names", () => {
    expect(IANA_TLDS.size).toBeGreaterThan(1400);
    for (const t of ["com", "org", "dev", "zip", "uk", "xn--p1ai", "example", "invalid", "test", "onion"]) {
      expect(isKnownTld(t), t).toBe(true);
    }
    for (const t of ["handle", "priv", "pvt", "official", "x1", ""]) expect(isKnownTld(t), t).toBe(false);
    expect(endsInKnownTld("no-dot")).toBe(false);
  });
});

describe("what links to a dotted handle seed", () => {
  const mk = (id: string, kind: string, value: string, source: string, metadata: Record<string, unknown> | null = null): Artifact => ({
    id, kind, value, confidence: 40, source, created_at: "2026-11-10T00:00:00Z", metadata,
  });
  const seedMates = (swept: string) => {
    const rows = [
      mk("seed", "username", "sample.handle", "user_seed"),
      mk("footprint", "social_footprint", `${swept} — 3 platform registrations`, "username_sweep", {
        handle: swept, tool: "username_sweep", via: "username_sweep", auto_recorded: true,
      }),
    ];
    const { clusters } = buildIdentityClusters(rows, "sample.handle");
    const c = clusters.find((x) => x.artifacts.some((a) => a.id === "seed"));
    return (c?.artifacts ?? []).map((a) => a.id).sort();
  };

  it("a sweep of the exact handle joins the seed", () => {
    expect(seedMates("sample.handle")).toEqual(["footprint", "seed"]);
  });

  it("a sweep of the shortened handle stays unlinked — a different handle is a different account", () => {
    expect(seedMates("sample")).toEqual(["seed"]);
  });
});
