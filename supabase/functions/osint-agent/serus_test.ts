/**
 * serus_test.ts — Deno tests for the HTTP transport of
 * supabase/functions/osint-agent/tools/serus.ts.
 *
 * The existing vitest test (src/test/serus-poller.test.ts) re-implements
 * the pure helpers. This file tests the *real* runSerusScan against a
 * stubbed globalThis.fetch so we catch regressions in:
 *   - Initiate body shape and headers
 *   - Initiate error → serusErrorPayload mapping
 *   - Poll loop: terminal on success/failed
 *   - Poll loop: timeout after maxRetries
 *   - Reveal mode waits for terminal success, then does one reveal fetch
 *   - Auth header on every fetch (Bearer + JSON)
 *   - Missing key → no network call, returns config error
 */
import {
  assertEquals,
  assertExists,
  assertStringIncludes,
  assertFalse,
} from "jsr:@std/assert@^1";
import { stub } from "jsr:@std/testing@^1/mock";

import {
  runSerusScan,
  parseInitiateResponse,
  isTerminalStatus,
  shapeTerminalResult,
} from "./tools/serus_core.ts";
import { SERUS_API_KEY } from "./env.ts";

// ---- Pure parsers (imported from real module, not re-implemented) --------

Deno.test("parseInitiateResponse: 200 + valid body returns scanId", () => {
  const r = parseInitiateResponse(
    JSON.stringify({ id: "abc123", status: "processing" }),
    200,
  );
  assertEquals(r, { scanId: "abc123", ok: true });
});

Deno.test("parseInitiateResponse: 4xx returns null scanId + ok=false", () => {
  const r = parseInitiateResponse(
    JSON.stringify({ error: { code: "insufficient_balance" } }),
    402,
  );
  assertEquals(r, { scanId: null, ok: false });
});

Deno.test("parseInitiateResponse: 5xx returns null scanId + ok=false", () => {
  const r = parseInitiateResponse("upstream down", 503);
  assertEquals(r, { scanId: null, ok: false });
});

Deno.test("parseInitiateResponse: malformed JSON returns null scanId", () => {
  const r = parseInitiateResponse("<html>500</html>", 200);
  assertEquals(r, { scanId: null, ok: false });
});

Deno.test("parseInitiateResponse: body without id returns null scanId", () => {
  const r = parseInitiateResponse(JSON.stringify({ status: "processing" }), 200);
  assertEquals(r, { scanId: null, ok: false });
});

Deno.test("isTerminalStatus: success and failed are terminal, processing is not", () => {
  assertEquals(isTerminalStatus({ status: "success" }), true);
  assertEquals(isTerminalStatus({ status: "failed" }), true);
  assertEquals(isTerminalStatus({ status: "processing" }), false);
  assertEquals(isTerminalStatus(null), false);
  assertEquals(isTerminalStatus({}), false);
});

Deno.test("shapeTerminalResult: success maps isBreached/totals/classification", () => {
  const r = shapeTerminalResult(
    {
      status: "success",
      identifierType: "email",
      isBreached: true,
      breaches: [
        { breachAuthority: { name: "Bukalapak" }, isMasked: true },
        { breachAuthority: { name: "Appartoo" }, isMasked: true },
      ],
      pastes: [],
    },
    "scan1",
    "2026-06-05T04:33:14.977Z",
    false,
  );
  assertEquals(r.ok, true);
  assertEquals(r.isBreached, true);
  assertEquals(r.totalBreaches, 2);
  assertEquals(r.classification, "masked");
});

Deno.test("shapeTerminalResult: reveal=true tags sensitive_unmasked (F-B3)", () => {
  const r = shapeTerminalResult(
    { status: "success" },
    "scan2",
    "2026-06-05T04:33:14.977Z",
    true,
  );
  assertEquals(r.classification, "sensitive_unmasked");
});

// ---- runSerusScan (HTTP transport, the gap vitest can't fill) ------------

/** Build a sequence of fake fetch responses (initiate + N polls). */
function fakeFetchSequence(responses: Response[]) {
  let i = 0;
  return (input: RequestInfo | URL) => {
    if (i >= responses.length) {
      throw new Error(
        `fakeFetchSequence: no more responses (call #${i + 1} to ${String(input)})`,
      );
    }
    const r = responses[i++];
    return Promise.resolve(r);
  };
}

function okJson(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

Deno.test("runSerusScan: missing SERUS_API_KEY → config error, no network", async () => {
  // This test only runs if SERUS_API_KEY is genuinely unset in the env.
  // If you've set it for another test session, skip this assertion.
  if (SERUS_API_KEY) {
    console.log("SKIP: SERUS_API_KEY is set in this env");
    return;
  }
  let called = false;
  const fetchStub = stub(globalThis, "fetch", () => {
    called = true;
    return Promise.resolve(okJson({}));
  });
  try {
    const r = await runSerusScan("email", "test@example.com", {
      maxRetries: 1,
      intervalMs: 0,
    });
    assertEquals(r.ok, false);
    assertEquals(r.status, "error");
    assertEquals(r.error?.code, "serus_key_missing");
    assertEquals(called, false, "fetch should not be called when key is missing");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("runSerusScan: successful scan polls until terminal, returns shaped result", async () => {
  // Provide a fake key by writing to env first. (The env.ts module reads at
  // load time, so we need to be careful — but SERUS_API_KEY is exported as a
  // const, so we can't change it after the fact. Skip this test if the real
  // key isn't set OR if we can't override.)
  if (!SERUS_API_KEY) {
    console.log(
      "SKIP: SERUS_API_KEY is unset — run with SERUS_API_KEY=fake set to exercise transport",
    );
    return;
  }

  const responses = [
    okJson({ id: "scan-A", status: "processing", identifierType: "email" }),
    okJson({ status: "processing", identifierType: "email" }),
    okJson({ status: "processing", identifierType: "email" }),
    okJson({
      status: "success",
      identifierType: "email",
      isBreached: true,
      checkedAt: "2026-06-05T04:33:29.694Z",
      breaches: [
        { breachAuthority: { name: "Bukalapak" }, isMasked: true },
      ],
      pastes: [],
      extractedData: { emails: ["a@b.com"] },
    }),
  ];
  const fetchStub = stub(globalThis, "fetch", fakeFetchSequence(responses));
  try {
    const r = await runSerusScan("email", "victim@example.com", {
      maxRetries: 5,
      intervalMs: 0,
    });
    assertEquals(r.ok, true);
    assertEquals(r.status, "success");
    assertEquals(r.scanId, "scan-A");
    assertEquals(r.isBreached, true);
    assertEquals(r.totalBreaches, 1);
    assertEquals(r.classification, "masked");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("runSerusScan: terminal failed status → ok=false, status=failed", async () => {
  if (!SERUS_API_KEY) {
    console.log("SKIP: SERUS_API_KEY is unset");
    return;
  }
  const responses = [
    okJson({ id: "scan-F", status: "processing" }),
    okJson({ status: "failed", identifierType: "email", isBreached: false }),
  ];
  const fetchStub = stub(globalThis, "fetch", fakeFetchSequence(responses));
  try {
    const r = await runSerusScan("email", "x@y.com", {
      maxRetries: 3,
      intervalMs: 0,
    });
    assertEquals(r.ok, false);
    assertEquals(r.status, "failed");
    assertEquals(r.isBreached, false);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("runSerusScan: poll never reaches terminal → status=timeout, code=poll_exhausted", async () => {
  if (!SERUS_API_KEY) {
    console.log("SKIP: SERUS_API_KEY is unset");
    return;
  }
  // 1 initiate + 3 poll attempts (all returning 'processing'). With
  // maxRetries: 3 the loop runs 3 times and the final attempt returns
  // a non-terminal status, so we hit the poll_exhausted branch.
  const responses = [
    okJson({ id: "scan-T", status: "processing" }), // initiate
    okJson({ status: "processing" }),                // poll attempt 0
    okJson({ status: "processing" }),                // poll attempt 1
    okJson({ status: "processing" }),                // poll attempt 2
  ];
  const fetchStub = stub(globalThis, "fetch", fakeFetchSequence(responses));
  try {
    const r = await runSerusScan("email", "x@y.com", {
      maxRetries: 3,
      intervalMs: 0,
    });
    assertEquals(r.ok, false);
    assertEquals(r.status, "timeout");
    assertExists(r.error);
    assertEquals(r.error?.code, "poll_exhausted");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("runSerusScan: poll fetch fails on every attempt → status=timeout, code=poll_failed", async () => {
  if (!SERUS_API_KEY) {
    console.log("SKIP: SERUS_API_KEY is unset");
    return;
  }
  // Initiate succeeds, then every poll fetch throws. The last attempt's
  // catch fires and returns poll_failed (distinct from poll_exhausted).
  const fetchStub = stub(
    globalThis,
    "fetch",
    (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/darkweb/scans")) {
        return Promise.resolve(okJson({ id: "scan-NF", status: "processing" }));
      }
      return Promise.reject(new Error("socket hang up"));
    },
  );
  try {
    const r = await runSerusScan("email", "x@y.com", {
      maxRetries: 2,
      intervalMs: 0,
    });
    assertEquals(r.ok, false);
    assertEquals(r.status, "timeout");
    assertEquals(r.error?.code, "poll_failed");
    assertEquals(r.scanId, "scan-NF");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("runSerusScan: 401 on initiate → error with hint about rotating key", async () => {
  if (!SERUS_API_KEY) {
    console.log("SKIP: SERUS_API_KEY is unset");
    return;
  }
  const responses = [
    okJson({ error: { code: "unauthorized", message: "Invalid API key" } }, 401),
  ];
  const fetchStub = stub(globalThis, "fetch", fakeFetchSequence(responses));
  try {
    const r = await runSerusScan("email", "x@y.com", {
      maxRetries: 1,
      intervalMs: 0,
    });
    assertEquals(r.ok, false);
    assertEquals(r.status, "error");
    assertEquals(r.error?.code, "unauthorized");
    assertEquals(r.error?.status, 401);
    assertStringIncludes(r.error?.hint ?? "", "Rotate the key");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("runSerusScan: 402 on initiate → error with hint about credits", async () => {
  if (!SERUS_API_KEY) {
    console.log("SKIP: SERUS_API_KEY is unset");
    return;
  }
  const responses = [
    okJson({ error: { code: "insufficient_balance" } }, 402),
  ];
  const fetchStub = stub(globalThis, "fetch", fakeFetchSequence(responses));
  try {
    const r = await runSerusScan("email", "x@y.com", {
      maxRetries: 1,
      intervalMs: 0,
    });
    assertEquals(r.error?.code, "insufficient_balance");
    assertStringIncludes(r.error?.hint ?? "", "Top up");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("runSerusScan: initiate 200 but no id → error, no poll calls", async () => {
  if (!SERUS_API_KEY) {
    console.log("SKIP: SERUS_API_KEY is unset");
    return;
  }
  const responses = [
    okJson({ status: "processing" }), // no id
  ];
  const fetchStub = stub(globalThis, "fetch", fakeFetchSequence(responses));
  try {
    const r = await runSerusScan("email", "x@y.com", {
      maxRetries: 1,
      intervalMs: 0,
    });
    assertEquals(r.ok, false);
    assertEquals(r.status, "error");
    assertEquals(r.error?.code, "http_200");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("runSerusScan: reveal=true polls masked until success, then fetches reveal once", async () => {
  if (!SERUS_API_KEY) {
    console.log("SKIP: SERUS_API_KEY is unset");
    return;
  }
  const capturedUrls: string[] = [];
  const responses = [
    okJson({ id: "scan-R", status: "processing" }),
    okJson({ status: "processing" }),
    okJson({ status: "success", isBreached: false, breaches: [], pastes: [] }),
    okJson({ status: "success", isBreached: false, breaches: [], pastes: [] }),
  ];
  const fetchStub = stub(
    globalThis,
    "fetch",
    (input: RequestInfo | URL) => {
      capturedUrls.push(String(input));
      const r = responses[capturedUrls.length - 1];
      return Promise.resolve(r);
    },
  );
  try {
    const r = await runSerusScan("email", "x@y.com", {
      reveal: true,
      maxRetries: 3,
      intervalMs: 0,
    });
    assertEquals(r.ok, true);
    // First call is initiate (no query string).
    assertFalse(capturedUrls[0].includes("reveal"), "initiate should not have reveal param");
    assertFalse(capturedUrls[0].includes("?"), "initiate should not have query string");
    // Poll calls stay masked to avoid spending reveal credits repeatedly.
    assertFalse(capturedUrls[1].includes("reveal"), "poll should stay masked while processing");
    assertFalse(capturedUrls[2].includes("reveal"), "terminal poll should stay masked");
    // Only the final reveal fetch carries the query string.
    assertStringIncludes(capturedUrls[3], "?reveal=true");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("runSerusScan: reveal fetch failure keeps masked success result", async () => {
  if (!SERUS_API_KEY) {
    console.log("SKIP: SERUS_API_KEY is unset");
    return;
  }
  const responses = [
    okJson({ id: "scan-RF", status: "processing" }),
    okJson({ status: "success", identifierType: "email", isBreached: true, breaches: [], pastes: [] }),
    okJson({ error: { code: "forbidden", message: "Reveal scope missing" } }, 403),
  ];
  const fetchStub = stub(globalThis, "fetch", fakeFetchSequence(responses));
  try {
    const r = await runSerusScan("email", "x@y.com", {
      reveal: true,
      maxRetries: 2,
      intervalMs: 0,
    });
    assertEquals(r.ok, true);
    assertEquals(r.status, "success");
    assertEquals(r.reveal, false);
    assertEquals(r.revealRequested, true);
    assertExists(r.revealError);
    assertEquals(r.revealError?.code, "forbidden");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("runSerusScan: reveal=false omits query string from poll URLs", async () => {
  if (!SERUS_API_KEY) {
    console.log("SKIP: SERUS_API_KEY is unset");
    return;
  }
  const capturedUrls: string[] = [];
  const responses = [
    okJson({ id: "scan-R2", status: "processing" }),
    okJson({ status: "success", isBreached: false, breaches: [], pastes: [] }),
  ];
  const fetchStub = stub(
    globalThis,
    "fetch",
    (input: RequestInfo | URL) => {
      capturedUrls.push(String(input));
      return Promise.resolve(responses[capturedUrls.length - 1]);
    },
  );
  try {
    await runSerusScan("email", "x@y.com", {
      reveal: false,
      maxRetries: 2,
      intervalMs: 0,
    });
    assertFalse(capturedUrls[1].includes("reveal"), "reveal=false should not include reveal param");
    assertFalse(capturedUrls[1].includes("?"), "reveal=false should not have query string");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("runSerusScan: every fetch carries Bearer auth + JSON content-type", async () => {
  if (!SERUS_API_KEY) {
    console.log("SKIP: SERUS_API_KEY is unset");
    return;
  }
  const capturedHeaders: Array<Record<string, string>> = [];
  const responses = [
    okJson({ id: "scan-H", status: "processing" }),
    okJson({ status: "success", isBreached: false, breaches: [], pastes: [] }),
  ];
  const fetchStub = stub(
    globalThis,
    "fetch",
    (_input: RequestInfo | URL, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      capturedHeaders.push(h);
      return Promise.resolve(responses[capturedHeaders.length - 1]);
    },
  );
  try {
    await runSerusScan("email", "x@y.com", {
      maxRetries: 2,
      intervalMs: 0,
    });
    for (const h of capturedHeaders) {
      assertStringIncludes(h.Authorization, "Bearer ");
      assertEquals(h["Content-Type"], "application/json");
    }
  } finally {
    fetchStub.restore();
  }
});

Deno.test("runSerusScan: initiate body includes identifierType + identifierValue", async () => {
  if (!SERUS_API_KEY) {
    console.log("SKIP: SERUS_API_KEY is unset");
    return;
  }
  let initiateBody: unknown = null;
  const responses = [
    okJson({ id: "scan-B", status: "processing" }),
    okJson({ status: "success", isBreached: false, breaches: [], pastes: [] }),
  ];
  const fetchStub = stub(
    globalThis,
    "fetch",
    (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!initiateBody) {
        initiateBody = init?.body ? JSON.parse(String(init.body)) : null;
      }
      return Promise.resolve(responses.shift()!);
    },
  );
  try {
    await runSerusScan("phone", "+15551234567", {
      maxRetries: 2,
      intervalMs: 0,
    });
    const body = initiateBody as Record<string, unknown>;
    assertEquals(body.identifierType, "phone");
    assertEquals(body.identifierValue, "+15551234567");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("runSerusScan: poll network error mid-loop → returns timeout with scanId", async () => {
  if (!SERUS_API_KEY) {
    console.log("SKIP: SERUS_API_KEY is unset");
    return;
  }
  // First call (initiate) succeeds, then every poll fetch rejects.
  // Distinct from the test above: here maxRetries: 3 means we have one
  // successful poll between failures, exercising the "continue" path
  // before the final attempt's catch returns poll_failed.
  let pollCount = 0;
  const fetchStub = stub(
    globalThis,
    "fetch",
    (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/darkweb/scans")) {
        return Promise.resolve(okJson({ id: "scan-NE", status: "processing" }));
      }
      pollCount++;
      if (pollCount === 1) {
        // First poll succeeds with processing, then subsequent ones fail.
        return Promise.resolve(okJson({ status: "processing" }));
      }
      return Promise.reject(new Error("socket hang up"));
    },
  );
  try {
    const r = await runSerusScan("email", "x@y.com", {
      maxRetries: 3,
      intervalMs: 0,
    });
    assertEquals(r.ok, false);
    assertEquals(r.status, "timeout");
    assertEquals(r.error?.code, "poll_failed");
    assertEquals(r.scanId, "scan-NE");
  } finally {
    fetchStub.restore();
  }
});
