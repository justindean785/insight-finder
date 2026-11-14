// A CORS preflight is answered BEFORE index.ts's per-request reset of module-scoped
// run state (lib/cors-preflight.ts). Synthetic values only.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CORS_PREFLIGHT_MAX_AGE_S, corsPreflightEarlyDisabled, corsPreflightEarlySelfTest,
  corsPreflightResponse, isCorsPreflight,
} from "../../functions/osint-agent/lib/cors-preflight.ts";
import { corsHeaders } from "../../functions/osint-agent/env.ts";

const INDEX_SRC = Deno.readTextFileSync(new URL("../../functions/osint-agent/index.ts", import.meta.url));

Deno.test("isCorsPreflight: only OPTIONS", () => {
  assertEquals(isCorsPreflight(new Request("https://example.test/osint-agent?health=1&maintenance=1", { method: "OPTIONS" })), true);
  for (const method of ["GET", "HEAD", "POST"]) assertEquals(isCorsPreflight({ method }), false, method);
});

Deno.test("preflight answer: same 'ok' body and CORS headers setupRequest returned, plus a cache lifetime", async () => {
  const res = corsPreflightResponse(corsHeaders);
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert((res.headers.get("Access-Control-Allow-Headers") ?? "").includes("authorization"), "the sweep's Authorization header must be allowed");
  assert((res.headers.get("Access-Control-Allow-Methods") ?? "").includes("GET"));
  assertEquals(res.headers.get("Access-Control-Max-Age"), String(CORS_PREFLIGHT_MAX_AGE_S));
});

Deno.test("index.ts answers OPTIONS before the first per-request reset (and before the health probe)", () => {
  const serve = INDEX_SRC.slice(INDEX_SRC.indexOf("Deno.serve("));
  const preflight = serve.indexOf("if (isCorsPreflight(req) && !corsPreflightEarlyDisabled()) return corsPreflightResponse(corsHeaders);");
  const firstReset = serve.indexOf("degradedTools.clear();");
  const triageReset = serve.indexOf("triageState.ran = false;");
  const setup = serve.indexOf("await setupRequest(req)");
  assert(preflight > 0, "the early preflight return must be inside Deno.serve");
  assert(firstReset > 0 && triageReset > 0 && setup > 0);
  assert(preflight < firstReset && preflight < triageReset && preflight < setup, "OPTIONS must return before any module-state reset");
});

Deno.test("kill switch CORS_PREFLIGHT_EARLY_DISABLED is read from the env and reported LEGACY", () => {
  assertEquals(corsPreflightEarlyDisabled((k) => (k === "CORS_PREFLIGHT_EARLY_DISABLED" ? "true" : undefined)), true);
  assertEquals(corsPreflightEarlyDisabled(() => undefined), false);
  assert(corsPreflightEarlySelfTest(true).detail.startsWith("LEGACY"));
  assertEquals(corsPreflightEarlySelfTest(false).ok, true);
});
