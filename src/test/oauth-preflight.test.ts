import { describe, it, expect } from "vitest";
import { isOAuthProviderReady } from "@/lib/oauth-preflight";

describe("isOAuthProviderReady", () => {
  it("treats an opaque redirect as ready (configured provider → 302 to Google)", () => {
    expect(isOAuthProviderReady({ type: "opaqueredirect", status: 0 })).toBe(true);
  });

  it("treats status 0 as ready even without the opaqueredirect type flag", () => {
    expect(isOAuthProviderReady({ type: "basic", status: 0 })).toBe(true);
  });

  it("treats an explicit 3xx redirect as ready", () => {
    expect(isOAuthProviderReady({ type: "basic", status: 302 })).toBe(true);
  });

  it("treats a 400 (missing OAuth secret / provider not enabled) as NOT ready", () => {
    expect(isOAuthProviderReady({ type: "cors", status: 400 })).toBe(false);
  });

  it("treats a 2xx as NOT ready (authorize never answers 200 for a real redirect)", () => {
    expect(isOAuthProviderReady({ type: "basic", status: 200 })).toBe(false);
  });
});
