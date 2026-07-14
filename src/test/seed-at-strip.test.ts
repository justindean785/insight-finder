// WP1a: a leading "@" handle must classify as a username in BOTH the frontend
// classifier (src/lib/seed) and the edge classifier (validation.ts) so the run
// hits the username playbook + anchor read instead of the bare `unknown` lane —
// and the two must agree on the normalized cache key.
import { describe, it, expect } from "vitest";
import { detectSeed } from "@/lib/seed";
import { detectSeedServer } from "../../supabase/functions/osint-agent/validation";

describe("WP1a @-handle seed classification", () => {
  it("frontend detectSeed classifies @pjsmakka as a username (was `other`)", () => {
    const d = detectSeed("@pjsmakka");
    expect(d?.kind).toBe("username");
    expect(d?.normalized).toBe("pjsmakka");
  });
  it("edge detectSeedServer classifies @pjsmakka as a username (was `other`)", () => {
    const d = detectSeedServer("@pjsmakka");
    expect(d?.kind).toBe("username");
    expect(d?.normalized).toBe("pjsmakka");
  });
  it("both classifiers agree on the normalized cache key", () => {
    expect(detectSeed("@PjSmakka")?.normalized).toBe(detectSeedServer("@PjSmakka")?.normalized);
  });
  it("a bare handle still works and an email is untouched", () => {
    expect(detectSeedServer("pjsmakka")?.kind).toBe("username");
    expect(detectSeedServer("a@b.com")?.kind).toBe("email");
    expect(detectSeed("a@b.com")?.kind).toBe("email");
  });
});
