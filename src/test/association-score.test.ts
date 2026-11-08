/**
 * association-score tests — pin the rules the module exists to keep honest.
 *
 * Fixtures use the `classesOf` seam so source-class independence is
 * deterministic here; production resolves classes through
 * intel.independentSourceClasses (mirrors collapse to one class).
 *
 * Review rows are plain verdict strings ("dismissed" etc.) — the same shape
 * `isRejectedArtifact` accepts everywhere else (see analyst-decisions.ts).
 */
import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  associationLabel,
  bandFor,
  scoreAssociations,
  type AssociationReport,
} from "@/lib/association-score";

let seq = 0;
function art(
  kind: string,
  value: string,
  opts: { source?: string; metadata?: Record<string, unknown>; id?: string } = {},
): Artifact {
  seq += 1;
  return {
    id: opts.id ?? `a${seq}`,
    kind,
    value,
    source: opts.source ?? "test_tool",
    confidence: 50,
    created_at: "2026-11-08T12:00:00.000Z",
    metadata: opts.metadata ?? {},
  } as unknown as Artifact;
}

/** One class per distinct tag; rows sharing a tag are mirrors of one corpus. */
const classesByTag = (tag: (a: Artifact) => string) => (a: Artifact) => [tag(a)];

function pair(rep: AssociationReport, a: string, b: string) {
  return rep.pairs.find(
    (p) => (p.a === a && p.b === b) || (p.a === b && p.b === a),
  );
}

describe("bandFor rungs (80 · 60 · 40 — same as the cluster board)", () => {
  it("maps scores to bands", () => {
    expect(bandFor(80)).toBe("strong");
    expect(bandFor(79)).toBe("likely");
    expect(bandFor(60)).toBe("likely");
    expect(bandFor(59)).toBe("possible");
    expect(bandFor(40)).toBe("possible");
    expect(bandFor(39)).toBe("weak");
    expect(bandFor(0)).toBe("unlinked");
  });
});

describe("co-occurrence scoring", () => {
  it("one breach row naming email+handle lands at Likely (~62), never Strong", () => {
    // Verified shape: the live corpus-a row "pat.sample@example.test / quietfalcon77 / 192.0.2.45".
    const rep = scoreAssociations(
      [
        art("username", "quietfalcon77", { source: "oathnet corpus-a.example DB (user-provided intel)" }),
        art("breach_exposure", "corpus-a.example row: pat.sample@example.test / quietfalcon77 / 192.0.2.45"),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    const p = pair(rep, "email:pat.sample@example.test", "handle:quietfalcon77");
    expect(p).toBeDefined();
    expect(p!.band).toBe("likely");
    expect(p!.score).toBe(62); // noisy-OR(0.45, 0.30) = 0.615
    expect(p!.reasons.join(" ")).toContain("Seen together");
  });

  it("mirrors of one corpus count as ONE observation — N providers, same class, same score as one", () => {
    const rows = (n: number) => {
      const out = [art("username", "quietfalcon77", { id: "u1" })];
      for (let i = 0; i < n; i++) {
        out.push(art("breach_exposure", `corpus-a.example row: pat.sample@example.test / quietfalcon77 (copy ${i})`, { id: `b${i}` }));
      }
      return out;
    };
    const one = scoreAssociations(rows(1), null, undefined, { classesOf: classesByTag(() => "breach") });
    const three = scoreAssociations(rows(3), null, undefined, { classesOf: classesByTag(() => "breach") });
    expect(pair(three, "email:pat.sample@example.test", "handle:quietfalcon77")!.score)
      .toBe(pair(one, "email:pat.sample@example.test", "handle:quietfalcon77")!.score);
  });

  it("a second INDEPENDENT class raises the score", () => {
    const oneClass = scoreAssociations(
      [
        art("username", "quietfalcon77", { id: "u1" }),
        art("breach_exposure", "corpus-a.example row: pat.sample@example.test / quietfalcon77", { id: "b1" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    const twoClasses = scoreAssociations(
      [
        art("username", "quietfalcon77", { id: "u1" }),
        art("breach_exposure", "corpus-a.example row: pat.sample@example.test / quietfalcon77", { id: "b1" }),
        art("account_id", "AFF record: quietfalcon77 on pat.sample@example.test", { id: "b2" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag((a) => (a.kind === "account_id" ? "aff" : "breach")) },
    );
    const s1 = pair(oneClass, "email:pat.sample@example.test", "handle:quietfalcon77")!.score!;
    const s2 = pair(twoClasses, "email:pat.sample@example.test", "handle:quietfalcon77")!.score!;
    expect(s2).toBeGreaterThan(s1);
    expect(s2).toBeLessThanOrEqual(100);
  });

  it("state agreement across two independent classes adds weight with a stated reason", () => {
    const rep = scoreAssociations(
      [
        art("email", "a@example.com", { id: "e1" }),
        art("email", "b@example.com", { id: "e2" }),
        art("breach_exposure", "row: a@example.com / b@example.com", { id: "r1", metadata: { state: "ID" } }),
        art("breach_exposure", "corpus copy: a@example.com / b@example.com", { id: "r2", metadata: { state: "ID" } }),
      ],
      null,
      undefined,
      { classesOf: classesByTag((a) => (a.id === "r2" ? "corpus_b" : "corpus_a")) },
    );
    const p = pair(rep, "email:a@example.com", "email:b@example.com");
    expect(p!.reasons.join(" ")).toContain("State 'id' agrees");
  });
});

describe("rule 3 — quarantine withholds only without a clean witness", () => {
  it("a fully quarantined selector gets NO figure", () => {
    const rep = scoreAssociations(
      [
        art("email", "other.sample@example.test", {
          id: "e1",
          metadata: { subject_unlinked: true, subject_unlinked_reason: "name-only harvest" },
        }),
        art("username", "quietfalcon77", { id: "u1" }),
        art("breach_exposure", "corpus-b row: other.sample@example.test / quietfalcon77", {
          id: "b1",
          metadata: { subject_unlinked: true },
        }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    const p = pair(rep, "email:other.sample@example.test", "handle:quietfalcon77");
    expect(p).toBeDefined();
    expect(p!.band).toBe("withheld");
    expect(p!.score).toBeNull();
  });

  it("ONE clean witness releases the selector — inherited quarantine cannot zero a live link", () => {
    // The motivating upload case: pat.sample@example.test was quarantined as a name-only
    // harvest, but the analyst-uploaded corpus-a row observes it directly.
    const rep = scoreAssociations(
      [
        art("email", "pat.sample@example.test", {
          id: "e1",
          metadata: { subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query" },
        }),
        art("username", "quietfalcon77", { id: "u1" }),
        art("breach_exposure", "corpus-a.example row: pat.sample@example.test / quietfalcon77 / 192.0.2.45", { id: "b1" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    const p = pair(rep, "email:pat.sample@example.test", "handle:quietfalcon77");
    expect(p!.band).not.toBe("withheld");
    expect(p!.score).toBeGreaterThan(0);
  });
});

describe("rule 2 — analyst verdicts are authority, never evidence", () => {
  it("a rejected row is removed from scoring entirely", () => {
    // The rejected email row is the ONLY carrier of that selector.
    const rep = scoreAssociations(
      [
        art("email", "sam.sample@example.test", { id: "rej1" }),
        art("username", "samsample", { id: "u1" }),
      ],
      null,
      { rej1: "dismissed" },
      { classesOf: classesByTag(() => "breach") },
    );
    expect(rep.pairs.every((p) => !p.a.includes("sam.sample@example.test") && !p.b.includes("sam.sample@example.test"))).toBe(true);
    expect(rep.stats.excluded).toBe(1);
  });

  it("a CONFIRMED verdict adds no points (JD 2026-11-02: decisions are authority)", () => {
    const rows = () => [
      art("username", "quietfalcon77", { id: "u1" }),
      art("breach_exposure", "corpus-a.example row: pat.sample@example.test / quietfalcon77", { id: "b1" }),
    ];
    const plain = scoreAssociations(rows(), null, undefined, { classesOf: classesByTag(() => "breach") });
    const confirmed = scoreAssociations(rows(), null, { b1: "confirmed" }, { classesOf: classesByTag(() => "breach") });
    expect(pair(confirmed, "email:pat.sample@example.test", "handle:quietfalcon77")!.score)
      .toBe(pair(plain, "email:pat.sample@example.test", "handle:quietfalcon77")!.score);
  });
});

describe("rule 5 — infrastructure never implies identity", () => {
  it("infra-only support caps at 35", () => {
    const rep = scoreAssociations(
      [
        art("email", "x@example.com", { id: "e1" }),
        art("ip", "192.0.2.45", { id: "i1" }),
        art("breach_exposure", "row: x@example.com / 192.0.2.45", { id: "b1" }),
        art("breach_exposure", "second corpus row: x@example.com / 192.0.2.45", { id: "b2" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag((a) => (a.id === "b2" ? "corpus_b" : "corpus_a")) },
    );
    const p = pair(rep, "email:x@example.com", "ip:192.0.2.45");
    expect(p!.score).toBeLessThanOrEqual(35);
    expect(p!.infraOnly).toBe(true);
    expect(p!.opposing.join(" ")).toContain("capped");
  });
});

describe("rule 6 — model-authored rows are output, not evidence", () => {
  it("a `finding` row asserting a link creates NO score", () => {
    const rep = scoreAssociations(
      [
        art("email", "a@example.com", { id: "e1" }),
        art("email", "b@example.com", { id: "e2" }),
        art("finding", "a@example.com and b@example.com are operated by the same individual", { id: "f1" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    expect(pair(rep, "email:a@example.com", "email:b@example.com")).toBeUndefined();
  });

  it("a minimax correlate summary row creates NO score", () => {
    const rep = scoreAssociations(
      [
        art("email", "a@example.com", { id: "e1" }),
        art("name", "Pat Sample", { id: "n1" }),
        art("other", "Identity cluster: a@example.com = Pat Sample", { id: "o1", source: "minimax correlate" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "unknown") },
    );
    expect(rep.pairs.find((p) => p.aValue.includes("a@example.com") || p.bValue.includes("a@example.com"))).toBeUndefined();
  });

  it("a PDF document row does not manufacture selectors from its filename", () => {
    // The attachment-seed bug: "exportjordan.sample@example.test_2026-11-08T12_53_51.pdf"
    // is a FILENAME, not a mailbox.
    const rep = scoreAssociations(
      [
        art("email", "jordan.sample@example.test", { id: "e1" }),
        art("other", "exportjordan.sample@example.test_2026-11-08T12_53_51.015Z.pdf (18-page report)", {
          id: "d1",
          metadata: { content_type: "application/pdf" },
        }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "unknown") },
    );
    expect(rep.pairs.find((p) => p.aValue.includes("exportjordan.sample") || p.bValue.includes("exportjordan.sample"))).toBeUndefined();
  });
});

describe("contradictions", () => {
  it("conflicting DOB multiplies ×0.6 and says so", () => {
    const rep = scoreAssociations(
      [
        art("email", "a@example.com", { id: "e1", metadata: { dob: "1987-06-30" } }),
        art("email", "b@example.com", { id: "e2", metadata: { dob: "1990-01-01" } }),
        art("breach_exposure", "row: a@example.com / b@example.com", { id: "r1" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    const p = pair(rep, "email:a@example.com", "email:b@example.com");
    // noisy-OR(0.50, 0.30) = 65, ×0.6 → 39, weak
    expect(p!.opposing.join(" ")).toContain("Conflicting DOB");
    expect(p!.score).toBe(39);
    expect(p!.band).toBe("weak");
  });
});

describe("common-handle dampener", () => {
  it("a handle seen with >2 distinct emails earns half weight", () => {
    const rep = scoreAssociations(
      [
        art("username", "commonhandle", { id: "u1" }),
        art("breach_exposure", "row1: commonhandle / a@example.com", { id: "r1" }),
        art("breach_exposure", "row2: commonhandle / b@example.com", { id: "r2" }),
        art("breach_exposure", "row3: commonhandle / c@example.com", { id: "r3" }),
        art("breach_exposure", "row4: commonhandle / d@example.com", { id: "r4" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag((a) => `c_${a.id}`) },
    );
    const p = pair(rep, "handle:commonhandle", "email:a@example.com");
    expect(p!.opposing.join(" ")).toContain("common-handle dampener");
  });
});

describe("output discipline", () => {
  it("is deterministic — same input, same report", () => {
    const rows = () => [
      art("username", "quietfalcon77", { id: "u1" }),
      art("breach_exposure", "corpus-a.example row: pat.sample@example.test / quietfalcon77", { id: "b1" }),
    ];
    const r1 = scoreAssociations(rows(), null, undefined, { classesOf: classesByTag(() => "breach") });
    const r2 = scoreAssociations(rows(), null, undefined, { classesOf: classesByTag(() => "breach") });
    expect(JSON.stringify(r1.pairs)).toBe(JSON.stringify(r2.pairs));
  });

  it("labels never say confirmed", () => {
    for (const s of [10, 45, 62, 80, 100]) {
      expect(associationLabel({ score: s, band: bandFor(s) }).toLowerCase()).not.toContain("confirmed");
    }
    expect(associationLabel({ score: null, band: "withheld" })).toContain("Withheld");
  });

  it("cluster aggregates never score below their strongest cross pair", () => {
    const rep = scoreAssociations(
      [
        art("username", "quietfalcon77", { id: "u1" }),
        art("breach_exposure", "corpus-a.example row: pat.sample@example.test / quietfalcon77", { id: "b1" }),
        art("email", "other@example.com", { id: "e1" }),
        art("account_id", "other@example.com profile references quietfalcon77", { id: "b2" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag((a) => (a.kind === "account_id" ? "aff" : "breach")) },
    );
    for (const c of rep.clusters) {
      const maxPair = Math.max(...c.topPairs.map((p) => p.score ?? 0));
      expect(c.score).toBeGreaterThanOrEqual(maxPair);
      expect(c.score).toBeLessThanOrEqual(100);
    }
  });
});
