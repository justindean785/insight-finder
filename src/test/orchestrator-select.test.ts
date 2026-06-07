import { describe, it, expect } from "vitest";
import {
  selectOrchestrator,
  defaultProfiles,
  PROVIDER_IDS,
  type ProviderId,
} from "../../supabase/functions/osint-agent/orchestrator_select.ts";

const avail = (...on: ProviderId[]): Record<ProviderId, boolean> => {
  const a = { minimax: false, openadapter: false, grok: false, lovable: false };
  for (const id of on) a[id] = true;
  return a;
};
const profiles = defaultProfiles();

describe("selectOrchestrator — behavior preserved (minimax + lovable only)", () => {
  it("uses MiniMax as primary when available and no overflow", () => {
    const c = selectOrchestrator({ available: avail("minimax", "lovable"), profiles, overflow: false });
    expect(c.providerId).toBe("minimax");
    expect(c.reason).toBe("primary");
    expect([c.inRate, c.outRate]).toEqual([0.3, 1.2]);
  });

  it("falls back to Lovable/Gemini on context overflow", () => {
    const c = selectOrchestrator({ available: avail("minimax", "lovable"), profiles, overflow: true });
    expect(c.providerId).toBe("lovable");
    expect(c.reason).toBe("overflow");
    expect([c.inRate, c.outRate]).toEqual([1.25, 10]);
  });

  it("falls back to Lovable when MiniMax key is missing", () => {
    const c = selectOrchestrator({ available: avail("lovable"), profiles, overflow: false });
    expect(c.providerId).toBe("lovable");
    expect(c.reason).toBe("fallback");
  });

  it("throws when nothing is configured", () => {
    expect(() => selectOrchestrator({ available: avail(), profiles, overflow: false })).toThrow(/No orchestrator provider/);
  });
});

describe("selectOrchestrator — new providers", () => {
  it("honors an operator-pinned provider when its key is present", () => {
    const c = selectOrchestrator({
      available: avail("minimax", "openadapter"),
      profiles,
      overflow: false,
      preferred: "openadapter",
    });
    expect(c.providerId).toBe("openadapter");
    expect(c.reason).toBe("preferred");
  });

  it("ignores a pinned provider whose key is absent (keeps MiniMax)", () => {
    const c = selectOrchestrator({
      available: avail("minimax"),
      profiles,
      overflow: false,
      preferred: "grok",
    });
    expect(c.providerId).toBe("minimax");
  });

  it("prefers a large-context provider on overflow (OpenAdapter over Grok)", () => {
    // grok is not large-context by default, openadapter is.
    const c = selectOrchestrator({ available: avail("openadapter", "grok"), profiles, overflow: true });
    expect(c.providerId).toBe("openadapter");
    expect(c.reason).toBe("overflow");
  });

  it("uses Grok as a fallback when it's the only key", () => {
    const c = selectOrchestrator({ available: avail("grok"), profiles, overflow: false });
    expect(c.providerId).toBe("grok");
    expect(c.model).toBe("grok-4.3");
  });

  it("on overflow with only a small-context provider, still selects it", () => {
    const c = selectOrchestrator({ available: avail("grok"), profiles, overflow: true });
    expect(c.providerId).toBe("grok");
    expect(c.reason).toBe("overflow");
  });
});

describe("defaultProfiles", () => {
  it("covers every provider id", () => {
    for (const id of PROVIDER_IDS) expect(profiles[id]).toBeDefined();
  });

  it("applies model/rate overrides", () => {
    const p = defaultProfiles({ openadapter: { model: "qwen-3.5" }, grok: { inRate: 9 } });
    expect(p.openadapter.model).toBe("qwen-3.5");
    expect(p.grok.inRate).toBe(9);
    expect(p.minimax.model).toBe("MiniMax-M2.7"); // untouched
  });
});
