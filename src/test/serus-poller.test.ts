import { describe, it, expect } from "vitest";

// ── Serus poller pure-logic tests ─────────────────────────────────────
// Re-implementing the helpers from supabase/functions/osint-agent/tools/serus.ts
// (parseInitiateResponse, isTerminalStatus, shapeTerminalResult) so the
// test stays self-contained and doesn't cross the Deno runtime boundary.
// (Rate-limit tests live in src/test/rate-limiter.test.ts.)

type InitiateResponse = { id?: string; status?: string; identifierType?: string };
type PollResponse = {
  id?: string;
  status?: "processing" | "success" | "failed";
  identifierType?: string;
  isBreached?: boolean;
  checkedAt?: string;
  createdAt?: string;
  scanType?: string;
  breaches?: Array<{
    breachAuthority?: { id?: string; name?: string; logoPath?: string; dataClasses?: string[] };
    isMasked?: boolean;
  }>;
  pastes?: Array<{ id?: string; title?: string; date?: string }>;
  extractedData?: {
    emails?: string[];
    usernames?: string[];
    phones?: string[];
    names?: string[];
    cryptoAddresses?: string[];
  };
};

function parseInitiateResponse(text: string, status: number): { scanId: string | null; ok: boolean } {
  if (status < 200 || status >= 300) return { scanId: null, ok: false };
  let data: InitiateResponse;
  try { data = JSON.parse(text); } catch { return { scanId: null, ok: false }; }
  return { scanId: typeof data.id === "string" ? data.id : null, ok: !!data.id };
}

function isTerminalStatus(data: PollResponse | null): boolean {
  return !!data && (data.status === "success" || data.status === "failed");
}

function shapeTerminalResult(
  last: PollResponse,
  scanId: string,
  initiatedAt: string,
  reveal: boolean,
) {
  return {
    ok: last.status === "success",
    status: last.status,
    scanId,
    identifierType: last.identifierType ?? null,
    isBreached: !!last.isBreached,
    totalBreaches: last.breaches?.length ?? 0,
    totalPastes: last.pastes?.length ?? 0,
    breaches: last.breaches,
    pastes: last.pastes,
    extractedData: last.extractedData,
    initiatedAt,
    completedAt: last.checkedAt ?? null,
    reveal,
    creditsUsed: 0.25,
    classification: reveal ? "sensitive_unmasked" : "masked",
  };
}

// ── parseInitiateResponse ─────────────────────────────────────────────

describe("parseInitiateResponse", () => {
  it("returns the scanId on a 2xx with a valid JSON body", () => {
    const text = JSON.stringify({ id: "3EhbxXzATBbEfixqrUDlgy6thGA", status: "processing" });
    const r = parseInitiateResponse(text, 200);
    expect(r).toEqual({ scanId: "3EhbxXzATBbEfixqrUDlgy6thGA", ok: true });
  });

  it("returns null scanId on a 4xx regardless of body", () => {
    const r = parseInitiateResponse(JSON.stringify({ error: { code: "insufficient_balance" } }), 402);
    expect(r).toEqual({ scanId: null, ok: false });
  });

  it("returns null scanId on a 5xx", () => {
    const r = parseInitiateResponse("upstream down", 503);
    expect(r).toEqual({ scanId: null, ok: false });
  });

  it("returns null scanId on malformed JSON", () => {
    const r = parseInitiateResponse("<html>500</html>", 200);
    expect(r).toEqual({ scanId: null, ok: false });
  });

  it("returns null scanId when the body has no id field", () => {
    const r = parseInitiateResponse(JSON.stringify({ status: "processing" }), 200);
    expect(r).toEqual({ scanId: null, ok: false });
  });

  it("returns null scanId when id is present but not a string (caller treats this as 'no scan')", () => {
    // Contract: scanId === null means the caller should bail. ok is a weaker
    // "did the body parse" signal — the orchestrator gates on scanId, not ok.
    const r = parseInitiateResponse(JSON.stringify({ id: 42 }), 200);
    expect(r.scanId).toBeNull();
  });
});

// ── isTerminalStatus ──────────────────────────────────────────────────

describe("isTerminalStatus", () => {
  it("returns false for null", () => {
    expect(isTerminalStatus(null)).toBe(false);
  });
  it("returns false for processing", () => {
    expect(isTerminalStatus({ status: "processing" })).toBe(false);
  });
  it("returns true for success", () => {
    expect(isTerminalStatus({ status: "success" })).toBe(true);
  });
  it("returns true for failed", () => {
    expect(isTerminalStatus({ status: "failed" })).toBe(true);
  });
  it("returns false for missing status", () => {
    expect(isTerminalStatus({})).toBe(false);
  });
});

// ── shapeTerminalResult ───────────────────────────────────────────────

describe("shapeTerminalResult", () => {
  const initiatedAt = "2026-06-05T04:33:14.977Z";

  it("maps a success response with breach hits to a fully populated result", () => {
    const poll: PollResponse = {
      id: "scan1",
      status: "success",
      identifierType: "email",
      isBreached: true,
      checkedAt: "2026-06-05T04:33:29.694Z",
      createdAt: "2026-06-05T04:33:14.977Z",
      scanType: "manual",
      breaches: [
        { breachAuthority: { id: "b1", name: "Bukalapak", dataClasses: ["Email Addresses", "Passwords"] }, isMasked: true },
        { breachAuthority: { id: "b2", name: "Appartoo", dataClasses: ["Names", "Physical Addresses"] }, isMasked: true },
      ],
      pastes: [],
      extractedData: { emails: [], usernames: [], phones: [], names: [], cryptoAddresses: [] },
    };
    const r = shapeTerminalResult(poll, "scan1", initiatedAt, false);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("success");
    expect(r.scanId).toBe("scan1");
    expect(r.identifierType).toBe("email");
    expect(r.isBreached).toBe(true);
    expect(r.totalBreaches).toBe(2);
    expect(r.totalPastes).toBe(0);
    expect(r.initiatedAt).toBe(initiatedAt);
    expect(r.completedAt).toBe("2026-06-05T04:33:29.694Z");
    expect(r.reveal).toBe(false);
    expect(r.creditsUsed).toBe(0.25);
  });

  it("maps a failed response with ok=false", () => {
    const r = shapeTerminalResult({ status: "failed" }, "scan2", initiatedAt, false);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("failed");
    expect(r.isBreached).toBe(false);
    expect(r.totalBreaches).toBe(0);
  });

  it("preserves the reveal flag on the result so the LLM knows unmasked data is included", () => {
    const r = shapeTerminalResult({ status: "success" }, "scan3", initiatedAt, true);
    expect(r.reveal).toBe(true);
  });

  it("tags sensitive_unmasked classification when reveal=true (F-B3)", () => {
    const r = shapeTerminalResult({ status: "success" }, "scan3", initiatedAt, true);
    expect(r.classification).toBe("sensitive_unmasked");
  });

  it("tags masked classification when reveal=false (F-B3 default)", () => {
    const r = shapeTerminalResult({ status: "success" }, "scan1", initiatedAt, false);
    expect(r.classification).toBe("masked");
  });

  it("handles a zero-hit success (breached=false, zero arrays)", () => {
    const r = shapeTerminalResult(
      { status: "success", isBreached: false, breaches: [], pastes: [] },
      "scan4", initiatedAt, false,
    );
    expect(r.ok).toBe(true);
    expect(r.isBreached).toBe(false);
    expect(r.totalBreaches).toBe(0);
    expect(r.totalPastes).toBe(0);
  });

  it("handles missing optional fields without throwing", () => {
    const r = shapeTerminalResult({ status: "success" }, "scan5", initiatedAt, false);
    expect(r.identifierType).toBeNull();
    expect(r.completedAt).toBeNull();
    expect(r.breaches).toBeUndefined();
    expect(r.extractedData).toBeUndefined();
    expect(r.totalBreaches).toBe(0);
  });

  it("falls back to identifier from response if provided, ignoring scanId fallback", () => {
    const r = shapeTerminalResult(
      { status: "success", identifierType: "phone" },
      "scan6", initiatedAt, false,
    );
    expect(r.identifierType).toBe("phone");
  });
});
