import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { subjectPatch, caseLacksSubject } from "@/lib/set-subject";

/**
 * "Set as subject" — the analyst names the subject of a case that has none
 * (an attachment-only first message). The patch rewrites `threads.seed_value`,
 * which the identity-cluster engine and the edge's next run both read, so the
 * guards ARE the feature: every way it can return null is pinned here first.
 */

const attachmentSeed =
  "Attached files:\n- [scan-notes.pdf](https://proj.storage.example/storage/v1/object/sign/attachments/u1/c1/scan-notes.pdf?token=eyJhbGciOiJIUzI1NiJ9.cGF5bG9h";

let n = 0;
function art(kind: string, value: string, meta: Record<string, unknown> = {}): Artifact {
  n += 1;
  return {
    id: `subj-${n}`, kind, value, confidence: 80, source: "hunter_verify",
    created_at: "2026-11-07T00:00:00Z",
    metadata: { sources: ["hunter_verify", "exa_search"], corroborations: 2, ...meta },
  } as Artifact;
}

describe("caseLacksSubject", () => {
  it("is true for an empty seed and an attachment-only seed", () => {
    expect(caseLacksSubject(null)).toBe(true);
    expect(caseLacksSubject("   ")).toBe(true);
    expect(caseLacksSubject(attachmentSeed)).toBe(true);
  });

  it("is false for a real seed, including a free-text one (a name is still the analyst's subject)", () => {
    expect(caseLacksSubject("j.harker@northgate-logistics.com")).toBe(false);
    expect(caseLacksSubject("James Harker Oakland CA")).toBe(false);
  });
});

describe("subjectPatch — the null cases", () => {
  const email = art("email", "subject@mail.example");

  it("is null when the case already has a subject", () => {
    expect(subjectPatch("j.harker@northgate-logistics.com", email)).toBeNull();
  });

  it("is null for a name, location or free-text row (a name is never linkage)", () => {
    for (const a of [art("name", "Jordan Vale"), art("location", "Oakland, California, US"), art("note", "see attached")]) {
      expect(subjectPatch(attachmentSeed, a)).toBeNull();
    }
  });

  it("is null for a quarantined, collision, conflicted or false-positive row", () => {
    const rows = [
      art("email", "q@mail.example", { subject_unlinked: true, subject_unlinked_reason: "name-only query" }),
      art("email", "c@mail.example", { possible_collision: true }),
      art("phone", "+1 415 555 0101", { conflict: true }),
      art("email", "fp@mail.example", { false_positive: true }),
    ];
    for (const a of rows) expect(subjectPatch(attachmentSeed, a)).toBeNull();
  });

  it("is null when the value does not parse as its kind", () => {
    expect(subjectPatch(attachmentSeed, art("email", "not an email"))).toBeNull();
    expect(subjectPatch(attachmentSeed, art("ip", "example.com"))).toBeNull();
  });
});

describe("subjectPatch — the write", () => {
  it("returns exactly seed_value, seed_type and title for a concrete selector", () => {
    const p = subjectPatch(attachmentSeed, art("email", "subject@mail.example"));
    expect(p).toEqual({ seed_value: "subject@mail.example", seed_type: "email", title: "Email: subject@mail.example" });
  });

  it("maps artifact kind spellings onto the seed kind", () => {
    expect(subjectPatch(null, art("handle", "subject_ops"))?.seed_type).toBe("username");
    expect(subjectPatch(null, art("ip_address", "198.51.100.9"))?.seed_type).toBe("ip");
    expect(subjectPatch(null, art("subdomain", "mail.example.com"))?.seed_type).toBe("domain");
    expect(subjectPatch(null, art("phone", "+1 415 555 0102"))?.seed_type).toBe("phone");
  });
});
