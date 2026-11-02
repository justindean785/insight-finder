import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveReadiness, isHealthProbe, handleHealthProbe } from "../../functions/osint-agent/health-handler.ts";

// ---------------------------------------------------------------------------
// deriveReadiness — pure function
// ---------------------------------------------------------------------------

Deno.test("deriveReadiness: requires SUPABASE_ANON_KEY for core ok", () => {
  const missingAnon = deriveReadiness({
    MINIMAX_API_KEY: "mm",
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service",
  });
  assertEquals(missingAnon.ok, false);
  assertEquals(missingAnon.checks.core.ok, false);
  assertEquals(
    missingAnon.checks.core.detail,
    "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY missing",
  );

  const ready = deriveReadiness({
    MINIMAX_API_KEY: "mm",
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    SUPABASE_ANON_KEY: "anon",
  });
  assertEquals(ready.ok, true);
  assertEquals(ready.checks.core.ok, true);
});

// ---------------------------------------------------------------------------
// isHealthProbe — pure function, no env dependencies
// ---------------------------------------------------------------------------

Deno.test("isHealthProbe: GET with ?health=1 → true", () => {
  const req = new Request("https://example.com/osint-agent?health=1", { method: "GET" });
  assertEquals(isHealthProbe(req), true);
});

Deno.test("isHealthProbe: HEAD with ?health=1 → true", () => {
  const req = new Request("https://example.com/osint-agent?health=1", { method: "HEAD" });
  assertEquals(isHealthProbe(req), true);
});

Deno.test("isHealthProbe: POST with ?health=1 → false", () => {
  const req = new Request("https://example.com/osint-agent?health=1", { method: "POST" });
  assertEquals(isHealthProbe(req), false);
});

Deno.test("isHealthProbe: GET without ?health → false", () => {
  const req = new Request("https://example.com/osint-agent", { method: "GET" });
  assertEquals(isHealthProbe(req), false);
});

Deno.test("isHealthProbe: GET with ?health=0 → false", () => {
  const req = new Request("https://example.com/osint-agent?health=0", { method: "GET" });
  assertEquals(isHealthProbe(req), false);
});

// ---------------------------------------------------------------------------
// handleHealthProbe — lightweight ?health=1 (public, no probe)
// ---------------------------------------------------------------------------

Deno.test("handleHealthProbe: ?health=1 returns 200/503 aligned with ok flag", async () => {
  const req = new Request("https://example.com/osint-agent?health=1", { method: "GET" });
  const res = await handleHealthProbe(req);
  const body = await res.json();
  assertEquals(res.status, body.ok ? 200 : 503);
  assertEquals(body.service, "osint-agent");
  assertEquals(typeof body.version, "string");
  assertEquals(typeof body.build, "string");
  assertEquals(typeof body.ok, "boolean");
  assertEquals(body.providers, undefined);
});

Deno.test("handleHealthProbe: ?health=1 does not leak providers block", async () => {
  const req = new Request("https://example.com/osint-agent?health=1", { method: "GET" });
  const res = await handleHealthProbe(req);
  const body = await res.json();
  assertEquals(body.providers, undefined);
});

Deno.test("handleHealthProbe: HEAD status matches readiness", async () => {
  const req = new Request("https://example.com/osint-agent?health=1", { method: "HEAD" });
  const res = await handleHealthProbe(req);
  assertEquals(res.status, res.ok ? 200 : 503);
  assertEquals(res.body, null);
});

// ---------------------------------------------------------------------------
// handleHealthProbe — ?probe=1 auth gating
// ---------------------------------------------------------------------------

Deno.test("handleHealthProbe: ?probe=1 without secret → 403", async () => {
  const req = new Request("https://example.com/osint-agent?health=1&probe=1", { method: "GET" });
  const res = await handleHealthProbe(req);
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error, "unauthorized");
  assertEquals(body.providers, undefined);
});

Deno.test("handleHealthProbe: ?probe=1 with wrong secret → 403", async () => {
  const req = new Request("https://example.com/osint-agent?health=1&probe=1", {
    method: "GET",
    headers: { "x-probe-secret": "wrong-value" },
  });
  const res = await handleHealthProbe(req);
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error, "unauthorized");
});

Deno.test("handleHealthProbe: ?probe=1 403 response does not leak provider details", async () => {
  const req = new Request("https://example.com/osint-agent?health=1&probe=1", { method: "GET" });
  const res = await handleHealthProbe(req);
  const body = await res.json();
  assertEquals(body.providers, undefined);
  assertEquals(body.checks, undefined);
  assertEquals(body.minimax, undefined);
  assertEquals(body.grok, undefined);
  assertEquals(body.lovable, undefined);
});

Deno.test("handleHealthProbe: OSINT_AGENT_PROBE_SECRET unset → ?probe=1 fails closed", async () => {
  const req = new Request("https://example.com/osint-agent?health=1&probe=1", {
    method: "GET",
    headers: { "x-probe-secret": "" },
  });
  const res = await handleHealthProbe(req);
  assertEquals(res.status, 403);
});

// ---------------------------------------------------------------------------
// checkMinimax — checks.minimax on plain ?health=1 (deps-injected, no network)
// ---------------------------------------------------------------------------

Deno.test("checkMinimax: missing key → ok:false reason:missing_key", async () => {
  const { checkMinimax } = await import("../../functions/osint-agent/health-handler.ts");
  const res = await checkMinimax({ hasKey: false });
  assertEquals(res.ok, false);
  assertEquals(res.reason, "missing_key");
});

Deno.test("checkMinimax: live ping ok → ok:true", async () => {
  const { checkMinimax } = await import("../../functions/osint-agent/health-handler.ts");
  const res = await checkMinimax({
    hasKey: true,
    recentlyHealthy: false,
    chat: (() =>
      Promise.resolve({ ok: true, status: 200, content: "pong", raw: {} })) as never,
  });
  assertEquals(res.ok, true);
});

Deno.test("checkMinimax: upstream 429 → ok:false reason:preflight_failed with status detail", async () => {
  const { checkMinimax } = await import("../../functions/osint-agent/health-handler.ts");
  const res = await checkMinimax({
    hasKey: true,
    recentlyHealthy: false,
    chat: (() =>
      Promise.resolve({ ok: false, status: 429, content: "", raw: {} })) as never,
  });
  assertEquals(res.ok, false);
  assertEquals(res.reason, "preflight_failed");
  assertEquals(res.detail, "status=429");
});

Deno.test("checkMinimax: aborted probe → ok:false reason:timeout", async () => {
  const { checkMinimax } = await import("../../functions/osint-agent/health-handler.ts");
  const res = await checkMinimax({
    hasKey: true,
    recentlyHealthy: false,
    chat: (() => Promise.reject(new DOMException("Aborted", "AbortError"))) as never,
  });
  assertEquals(res.ok, false);
  assertEquals(res.reason, "timeout");
});

Deno.test("checkMinimax: recent orchestrator success short-circuits the paid ping", async () => {
  const { checkMinimax } = await import("../../functions/osint-agent/health-handler.ts");
  const res = await checkMinimax({
    hasKey: true,
    recentlyHealthy: true,
    chat: (() => Promise.reject(new Error("must not be called"))) as never,
  });
  assertEquals(res.ok, true);
  assertEquals(res.detail, "recently_ok");
});

Deno.test("handleHealthProbe: checks.minimax present on plain ?health=1", async () => {
  const req = new Request("https://edge.test/osint-agent?health=1", { method: "GET" });
  const res = await handleHealthProbe(req);
  const body = await res.json();
  // Test env has no MINIMAX_API_KEY → the check must fail CLOSED with the
  // missing_key reason (never silently absent).
  assertEquals(typeof body.checks.minimax, "object");
  assertEquals(body.checks.minimax.ok, false);
  assertEquals(body.checks.minimax.reason, "missing_key");
});

// ---------------------------------------------------------------------------
// Maintenance gate (2026-10-19): a plain ?health=1 is a liveness probe and runs
// no database maintenance; ?maintenance=1 (or the authenticated ?probe=1) does.
// ---------------------------------------------------------------------------
import { MAINTENANCE_SKIPPED_DETAIL, maintenanceRequested, CREDENTIAL_HEALTH_SAMPLE_ROWS } from "../../functions/osint-agent/lib/credential-health.ts";
const HEALTH_SRC = Deno.readTextFileSync(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));

Deno.test("maintenanceRequested: plain ?health=1 → false; ?maintenance=1 → true", () => {
  const none = () => undefined;
  assertEquals(maintenanceRequested(new URL("https://x/osint-agent?health=1"), none), false);
  assertEquals(maintenanceRequested(new URL("https://x/osint-agent?health=1&maintenance=1"), none), true);
  assertEquals(maintenanceRequested(new URL("https://x/osint-agent?health=1&maintenance=0"), none), false);
});

Deno.test("maintenanceRequested: HEALTH_MAINTENANCE_ALWAYS=true restores the old every-probe behaviour", () => {
  const env = (k: string) => (k === "HEALTH_MAINTENANCE_ALWAYS" ? "true" : undefined);
  assertEquals(maintenanceRequested(new URL("https://x/osint-agent?health=1"), env), true);
});

Deno.test("handleHealthProbe: plain ?health=1 reports checks.maintenance as skipped and runs no sweep", async () => {
  const req = new Request("https://example.com/osint-agent?health=1", { method: "GET" });
  const res = await handleHealthProbe(req);
  const body = await res.json();
  assertEquals(body.checks.maintenance, { ok: true, detail: MAINTENANCE_SKIPPED_DETAIL });
  // None of the maintenance-only checks may appear on a liveness probe.
  for (const k of ["recovery", "rejected_cluster_sweep", "credentials", "synthesis", "cluster_adjudication", "cache_sweep"]) {
    assertEquals(body.checks[k], undefined, `${k} must not run on a plain probe`);
  }
});

Deno.test("handleHealthProbe: ?health=1&maintenance=1 does not report the probe as skipped", async () => {
  const req = new Request("https://example.com/osint-agent?health=1&maintenance=1", { method: "GET" });
  const res = await handleHealthProbe(req);
  const body = await res.json();
  // Without SUPABASE_URL/SERVICE_KEY in the test env the sweeps cannot run, but the
  // gate itself must not stamp the "skipped on a liveness probe" detail.
  assert(body.checks.maintenance === undefined || body.checks.maintenance.detail !== MAINTENANCE_SKIPPED_DETAIL);
});

Deno.test("credential health sample is bounded well under the old 5,000-row scan", () => {
  assert(CREDENTIAL_HEALTH_SAMPLE_ROWS <= 500 && CREDENTIAL_HEALTH_SAMPLE_ROWS >= 100);
  // Code lines only (comments may still describe the old read).
  const code = HEALTH_SRC.split("\n").filter((l) => !l.trim().startsWith("//"));
  assert(!code.some((l) => l.includes('count: "exact"')), "health-handler must not issue an exact-count scan");
  assert(!code.some((l) => l.includes(".limit(5000)")), "the 5,000-row credential read must stay gone");
});
