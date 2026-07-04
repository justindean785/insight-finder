import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveReadiness, isHealthProbe, handleHealthProbe } from "./health-handler.ts";

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
