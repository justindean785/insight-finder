/**
 * association-score tests — pin the rules the module exists to keep honest.
 *
 * All fixtures are SYNTHETIC: reserved domains (example.com/net, RFC 2606) and
 * TEST-NET-3 addresses (203.0.113.0/24, RFC 5737). No case data in the repo.
 *
 * The `classesOf` seam makes source-class independence deterministic here;
 * production resolves classes through intel.independentSourceClasses (mirrors
 * collapse to one class).
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
    created_at: "2026-01-01T00:00:00.000Z",
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

const HANDLE = "bravohandle";
const MB = "alpha@example.com";
const MB2 = "beta@example.net";
const IP = "203.0.113.10";
const CORPUS_ROW = `corpus-a.example row: ${MB} / ${HANDLE} / ${IP}`;

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

describe("co-occurrence scoring — one row is ONE observation", () => {
  it("a value-text sighting earns the shared weight ONLY: one breach row naming email+handle lands at Possible (45), never Likely", () => {
    // The double-count fix: a composite "email / handle / ip" text row used to
    // collect BOTH the co-occurrence weight and the declaration bonus for the
    // same sighting (45+30 → 62). Containment is not a declaration.
    const rep = scoreAssociations(
      [
        art("username", HANDLE, { id: "u1" }),
        art("breach_exposure", CORPUS_ROW, { id: "b1" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    const p = pair(rep, `email:${MB}`, `handle:${HANDLE}`);
    expect(p).toBeDefined();
    expect(p!.band).toBe("possible");
    expect(p!.score).toBe(45); // PAIR_WEIGHT email:handle = 0.45, nothing else
    expect(p!.reasons.join(" ")).toContain("Seen together");
    expect(p!.reasons.join(" ")).not.toContain("declared linking field");
  });

  it("a STRUCTURED declaration earns the co-record bonus: provider linking field → Likely (65)", () => {
    const rep = scoreAssociations(
      [
        art("email", MB, { id: "e1" }),
        art("email", MB2, { id: "e2" }),
        art("account_id", "provider profile row", {
          id: "p1",
          metadata: { email: MB, email_associated: MB2 },
        }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "provider") },
    );
    const p = pair(rep, `email:${MB}`, `email:${MB2}`);
    expect(p!.score).toBe(65); // noisy-OR(0.50, 0.30)
    expect(p!.band).toBe("likely");
    expect(p!.reasons.join(" ")).toContain("declared linking field");
  });

  it("a queried_selector provenance stamp is containment, not a declaration", () => {
    // The row exists because a lookup ran on MB2 — that says nothing about
    // what the record links. No declaration bonus.
    const rep = scoreAssociations(
      [
        art("email", MB, { id: "e1" }),
        art("email", MB2, { id: "e2" }),
        art("breach_exposure", `corpus row naming ${MB}`, {
          id: "b1",
          metadata: { queried_selector: MB2, query_types: ["email"] },
        }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    const p = pair(rep, `email:${MB}`, `email:${MB2}`);
    expect(p).toBeDefined();
    expect(p!.score).toBe(50); // email:email shared weight only
    expect(p!.reasons.join(" ")).not.toContain("declared linking field");
  });

  it("mirrors of one corpus count as ONE observation — N providers, same class, same score as one", () => {
    const rows = (n: number) => {
      const out = [art("username", HANDLE, { id: "u1" })];
      for (let i = 0; i < n; i++) {
        out.push(art("breach_exposure", `${CORPUS_ROW} (copy ${i})`, { id: `b${i}` }));
      }
      return out;
    };
    const one = scoreAssociations(rows(1), null, undefined, { classesOf: classesByTag(() => "breach") });
    const three = scoreAssociations(rows(3), null, undefined, { classesOf: classesByTag(() => "breach") });
    expect(pair(three, `email:${MB}`, `handle:${HANDLE}`)!.score)
      .toBe(pair(one, `email:${MB}`, `handle:${HANDLE}`)!.score);
  });

  it("a second INDEPENDENT class raises the score", () => {
    const oneClass = scoreAssociations(
      [
        art("username", HANDLE, { id: "u1" }),
        art("breach_exposure", CORPUS_ROW, { id: "b1" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    const twoClasses = scoreAssociations(
      [
        art("username", HANDLE, { id: "u1" }),
        art("breach_exposure", CORPUS_ROW, { id: "b1" }),
        art("account_id", `AFF record: ${HANDLE} on ${MB}`, { id: "b2" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag((a) => (a.kind === "account_id" ? "aff" : "breach")) },
    );
    const s1 = pair(oneClass, `email:${MB}`, `handle:${HANDLE}`)!.score!;
    const s2 = pair(twoClasses, `email:${MB}`, `handle:${HANDLE}`)!.score!;
    expect(s2).toBeGreaterThan(s1);
    expect(s2).toBe(70); // noisy-OR(0.45, 0.45) — two independent sightings
  });

  it("state agreement across two independent classes adds weight with a stated reason", () => {
    const rep = scoreAssociations(
      [
        art("email", MB, { id: "e1" }),
        art("email", MB2, { id: "e2" }),
        art("breach_exposure", `row: ${MB} / ${MB2}`, { id: "r1", metadata: { state: "ID" } }),
        art("breach_exposure", `corpus copy: ${MB} / ${MB2}`, { id: "r2", metadata: { state: "ID" } }),
      ],
      null,
      undefined,
      { classesOf: classesByTag((a) => (a.id === "r2" ? "corpus_b" : "corpus_a")) },
    );
    const p = pair(rep, `email:${MB}`, `email:${MB2}`);
    expect(p!.reasons.join(" ")).toContain("State 'id' agrees");
  });
});

describe("rule 3 — quarantine withholds without a clean witness, and quarantined rows testify nothing", () => {
  it("a fully quarantined selector gets NO figure", () => {
    const rep = scoreAssociations(
      [
        art("email", "quar@example.com", {
          id: "e1",
          metadata: { subject_unlinked: true, subject_unlinked_reason: "name-only harvest" },
        }),
        art("username", HANDLE, { id: "u1" }),
        art("breach_exposure", `corpus-b row: quar@example.com / ${HANDLE}`, {
          id: "b1",
          metadata: { subject_unlinked: true },
        }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    const p = pair(rep, "email:quar@example.com", `handle:${HANDLE}`);
    expect(p).toBeDefined();
    expect(p!.band).toBe("withheld");
    expect(p!.score).toBeNull();
  });

  it("ONE clean witness releases the selector — inherited quarantine cannot zero a live link", () => {
    // The live-case shape: a mailbox quarantined as a name-only harvest, then
    // observed directly by an analyst-uploaded breach row.
    const rep = scoreAssociations(
      [
        art("email", MB, {
          id: "e1",
          metadata: { subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query" },
        }),
        art("username", HANDLE, { id: "u1" }),
        art("breach_exposure", CORPUS_ROW, { id: "b1" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    const p = pair(rep, `email:${MB}`, `handle:${HANDLE}`);
    expect(p!.band).not.toBe("withheld");
    expect(p!.score).toBe(45); // from the clean row alone
  });

  it("a quarantined row's co-occurrence contributes NOTHING, even when both selectors have clean witnesses", () => {
    // The gate sees clean witnesses, so the pair is not withheld — but the
    // only sighting sits on a quarantined row, which testifies nothing.
    const rep = scoreAssociations(
      [
        art("email", MB, { id: "e1" }),
        art("username", HANDLE, { id: "u1" }),
        art("breach_exposure", `row: ${MB} / ${HANDLE}`, {
          id: "b1",
          metadata: { subject_unlinked: true, subject_unlinked_reason: "name-only harvest" },
        }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    expect(pair(rep, `email:${MB}`, `handle:${HANDLE}`)).toBeUndefined();
  });

  it("a quarantined mirror adds nothing — the clean row's score stands alone", () => {
    const cleanOnly = scoreAssociations(
      [art("username", HANDLE, { id: "u1" }), art("breach_exposure", CORPUS_ROW, { id: "b1" })],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    const withQuarMirror = scoreAssociations(
      [
        art("username", HANDLE, { id: "u1" }),
        art("breach_exposure", CORPUS_ROW, { id: "b1" }),
        art("breach_exposure", `${CORPUS_ROW} (quarantined copy)`, {
          id: "b2",
          metadata: { subject_unlinked: true },
        }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    expect(pair(withQuarMirror, `email:${MB}`, `handle:${HANDLE}`)!.score)
      .toBe(pair(cleanOnly, `email:${MB}`, `handle:${HANDLE}`)!.score);
  });
});

describe("rule 2 — analyst verdicts are authority, never evidence", () => {
  it("a rejected row is removed from scoring entirely", () => {
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

  it("a CONFIRMED verdict adds no points (decisions are authority, not evidence)", () => {
    const rows = () => [
      art("username", HANDLE, { id: "u1" }),
      art("breach_exposure", CORPUS_ROW, { id: "b1" }),
    ];
    const plain = scoreAssociations(rows(), null, undefined, { classesOf: classesByTag(() => "breach") });
    const confirmed = scoreAssociations(rows(), null, { b1: "confirmed" }, { classesOf: classesByTag(() => "breach") });
    expect(pair(confirmed, `email:${MB}`, `handle:${HANDLE}`)!.score)
      .toBe(pair(plain, `email:${MB}`, `handle:${HANDLE}`)!.score);
  });
});

describe("rule 5 — infrastructure never implies identity", () => {
  it("a declared IP field still caps at 35: infrastructure evidence, however structured, is not identity", () => {
    const rep = scoreAssociations(
      [
        art("email", "x@example.com", { id: "e1" }),
        art("ip", IP, { id: "i1" }),
        art("breach_exposure", "corpus row one", { id: "b1", metadata: { email: "x@example.com", ip: IP } }),
        art("breach_exposure", "corpus row two", { id: "b2", metadata: { email: "x@example.com", ip: IP } }),
      ],
      null,
      undefined,
      { classesOf: classesByTag((a) => (a.id === "b2" ? "corpus_b" : a.id === "b1" ? "corpus_a" : "own")) },
    );
    const p = pair(rep, "email:x@example.com", `ip:${IP}`);
    // Pre-cap: noisy-OR(0.15, 0.15, 0.30, 0.30) ≈ 65 → capped
    expect(p!.score).toBeLessThanOrEqual(35);
    expect(p!.infraOnly).toBe(true);
    expect(p!.opposing.join(" ")).toContain("capped");
  });
});

describe("rule 6 — model-authored rows are output, not evidence", () => {
  it("a `finding` row asserting a link creates NO score", () => {
    const rep = scoreAssociations(
      [
        art("email", MB, { id: "e1" }),
        art("email", MB2, { id: "e2" }),
        art("finding", `${MB} and ${MB2} are operated by the same individual`, { id: "f1" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    expect(pair(rep, `email:${MB}`, `email:${MB2}`)).toBeUndefined();
  });

  it("a minimax correlate summary row creates NO score", () => {
    const rep = scoreAssociations(
      [
        art("email", MB, { id: "e1" }),
        art("name", "Example Person", { id: "n1" }),
        art("other", `Identity cluster: ${MB} = Example Person`, { id: "o1", source: "minimax correlate" }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "unknown") },
    );
    expect(rep.pairs.find((p) => p.aValue.includes(MB) || p.bValue.includes(MB))).toBeUndefined();
  });

  it("a PDF document row does not manufacture selectors from its filename", () => {
    // The attachment-seed bug: "export<seed>@example.com_….pdf" is a FILENAME,
    // not a mailbox.
    const rep = scoreAssociations(
      [
        art("email", MB, { id: "e1" }),
        art("other", "exportalpha@example.com_2026-01-01T00_00_00.000Z.pdf (18-page report)", {
          id: "d1",
          metadata: { content_type: "application/pdf" },
        }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "unknown") },
    );
    expect(rep.pairs.find((p) => p.aValue.includes("exportalpha") || p.bValue.includes("exportalpha"))).toBeUndefined();
  });
});

describe("contradictions", () => {
  it("conflicting DOB multiplies ×0.6 and says so", () => {
    const rep = scoreAssociations(
      [
        art("email", MB, { id: "e1", metadata: { dob: "1987-06-30" } }),
        art("email", MB2, { id: "e2", metadata: { dob: "1990-01-01" } }),
        art("breach_exposure", "corpus row", { id: "r1", metadata: { email: MB, email_associated: MB2 } }),
      ],
      null,
      undefined,
      { classesOf: classesByTag(() => "breach") },
    );
    const p = pair(rep, `email:${MB}`, `email:${MB2}`);
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
    // 0.45 × 0.5 dampener = 0.225; noisy-OR in floating point gives
    // 100 × (1 − (1 − 0.225)) = 22.4999…, which rounds to 22. Weak either way.
    expect(p!.score).toBe(22);
    expect(p!.band).toBe("weak");
    expect(p!.opposing.join(" ")).toContain("common-handle dampener");
  });
});

describe("output discipline", () => {
  it("is deterministic — same input, same report", () => {
    const rows = () => [
      art("username", HANDLE, { id: "u1" }),
      art("breach_exposure", CORPUS_ROW, { id: "b1" }),
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
        art("username", HANDLE, { id: "u1" }),
        art("breach_exposure", CORPUS_ROW, { id: "b1" }),
        art("email", "other@example.com", { id: "e1" }),
        art("account_id", `other@example.com profile references ${HANDLE}`, { id: "b2" }),
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
