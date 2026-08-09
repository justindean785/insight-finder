import { describe, it, expect } from "vitest";
import { groupForKind, KIND_TO_PIVOT } from "@/lib/intel";

/**
 * Regressions from the leoseyes86@gmail.com report (2026-08-09).
 *
 * The header banner warned "Potential same-name collision detected" and "Phone
 * area codes across clusters disagree — likely different people", while the
 * Collision / Likely Unrelated section printed "_No collisions flagged._" in the
 * same document. Cause: the backend marks name-only harvests with
 * `subject_unlinked` + `subject_unlinked_reason`, and NOTHING in the frontend
 * read either field, so 20 quarantined artifacts rendered as ordinary Candidate
 * Identity Clusters (C003-C022).
 */
describe("ip / ip_address are one entity type", () => {
  it("groups both kinds under infrastructure", () => {
    // 206.111.150.4 was filed under "Other" and 75.169.97.217 under
    // "Infrastructure" in the same report.
    expect(groupForKind("ip")).toBe("infrastructure");
    expect(groupForKind("ip_address")).toBe("infrastructure");
    expect(groupForKind("ip_address")).toBe(groupForKind("ip"));
  });

  it("is case-insensitive, as groupForKind lowercases", () => {
    expect(groupForKind("IP_ADDRESS")).toBe("infrastructure");
  });

  it("routes both kinds to the same pivot type", () => {
    expect(KIND_TO_PIVOT.ip_address).toBe(KIND_TO_PIVOT.ip);
  });

  it("still sends genuinely unmapped kinds to other", () => {
    expect(groupForKind("not_a_real_kind")).toBe("other");
  });
});
