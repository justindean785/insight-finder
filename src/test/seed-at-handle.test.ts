/**
 * seed-at-handle — "@handle" is a username seed on BOTH halves.
 *
 * `@hoodken28` classified as `other` (USERNAME_RE has no `@`), so the thread
 * read "Type: other", the username playbook was lost, and the cache key kept
 * the `@` while artifact values stripped it. Frontend and server must agree.
 */
import { describe, it, expect } from "vitest";
import { detectSeed, formatThreadTitle } from "@/lib/seed";
import { detectSeedServer } from "../../supabase/functions/osint-agent/validation";

describe("@handle seeds", () => {
  it("frontend: @handle → username, normalized without the @", () => {
    expect(detectSeed("@qa_nightjar")).toEqual({ kind: "username", raw: "@qa_nightjar", normalized: "qa_nightjar" });
    expect(detectSeed("@QA.Nightjar-1")).toMatchObject({ kind: "username", normalized: "qa.nightjar-1" });
  });
  it("server: same answer", () => {
    expect(detectSeedServer("@qa_nightjar")).toEqual({ kind: "username", raw: "@qa_nightjar", normalized: "qa_nightjar" });
  });
  it("parity across the seed table", () => {
    for (const s of ["@qa_nightjar", "qa_nightjar", "qa@example.invalid", "203.0.113.57", "https://a.example/x", "+1 555 555 0100", "example.invalid"]) {
      const a = detectSeed(s), b = detectSeedServer(s);
      expect(a?.kind, s).toBe(b?.kind);
      expect(a?.normalized, s).toBe(b?.normalized);
    }
  });
  it("things that are not handles stay what they were", () => {
    expect(detectSeed("@")?.kind).toBe("other");
    expect(detectSeed("@@double")?.kind).toBe("other");
    expect(detectSeed("@has space")?.kind).toBe("other");
    expect(detectSeed("qa@example.invalid")?.kind).toBe("email");
  });
  it("the thread title labels it as a username", () => {
    expect(formatThreadTitle("@qa_nightjar")).toMatch(/username/i);
  });
});
