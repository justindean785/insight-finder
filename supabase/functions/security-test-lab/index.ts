// Security Test Lab — red-team harness for the OSINT agent's defenses.
// Mirrors the sanitizeToolOutput + assertSafeUrl logic from osint-agent so we
// can exercise them in isolation, then writes per-test rows + a run summary
// to public.security_tests. Admin-only (checked in code via has_role RPC).

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ---------- the REAL defenses, imported ----------
// These were mirrored copies, and the copies had drifted from what production
// actually does — which made the lab certify behaviour the agent does not have.
// The clearest case: the mirrored SENSITIVE_KEY_RE included
// `password|passwd|pwd|hash|salt|ssn|sin|dob|cc|credit_card|cvv|cvc|otp|mfa`,
// so the lab reported "password key stripped — PASSED (critical)". Production's
// regex deliberately excludes every one of those, because on an OSINT tool they
// are the INVESTIGATION TARGETS and must reach the investigator; it strips only
// our own service auth material. The lab was green on a control that does not
// exist, which is worse than having no test at all.
//
// safety.ts is dependency-free, so importing it across function directories
// bundles cleanly. Never re-mirror these: a copy is exactly how the above
// happened.
import {
  sanitizeToolOutput,
  assertSafeUrl,
  SENSITIVE_KEY_RE,
} from "../osint-agent/safety.ts";

// ---------- test cases ----------
type TestResult = {
  category: "prompt_injection" | "ssrf" | "oversize";
  name: string;
  passed: boolean;
  severity: "low" | "medium" | "high" | "critical";
  input_snippet: string;
  output_snippet: string;
  notes: string;
  duration_ms: number;
};

const SHORT = (s: string, n = 240) => (s.length > n ? s.slice(0, n) + "…" : s);

function runPromptInjectionTests(): TestResult[] {
  const cases: { name: string; severity: TestResult["severity"]; payload: unknown; expectKey: string; expectStripped: boolean }[] = [
    // Our own service auth material — MUST be stripped.
    { name: "api_key key stripped", severity: "critical", payload: { service: "x", api_key: "sk-live-abc123" }, expectKey: "api_key", expectStripped: true },
    { name: "nested token stripped", severity: "critical", payload: { account: { profile: { token: "bearer-xyz" } } }, expectKey: "token", expectStripped: true },
    { name: "session in array stripped", severity: "high", payload: [{ session: "abc" }, { session: "def" }], expectKey: "session", expectStripped: true },
    { name: "authorization key stripped", severity: "critical", payload: { authorization: "Bearer abc.def" }, expectKey: "authorization", expectStripped: true },
    { name: "private_key stripped", severity: "critical", payload: { private_key: "-----BEGIN KEY-----" }, expectKey: "private_key", expectStripped: true },

    // Investigation TARGETS — must pass through to the investigator. These
    // previously asserted the opposite and passed, because the lab's mirrored
    // regex redacted them and production's never did. Asserting pass-through is
    // what actually pins the documented OSINT design: if someone widens
    // SENSITIVE_KEY_RE to look "safer", these fail and say why.
    { name: "password passes through (OSINT target)", severity: "critical", payload: { user: "alice", password: "hunter2" }, expectKey: "password", expectStripped: false },
    { name: "ssn passes through (OSINT target)", severity: "critical", payload: { name: "Bob", ssn: "123-45-6789" }, expectKey: "ssn", expectStripped: false },
    { name: "dob passes through (OSINT target)", severity: "high", payload: { dob: "1990-01-01" }, expectKey: "dob", expectStripped: false },
    { name: "hash passes through (OSINT target)", severity: "high", payload: { hash: "5f4dcc3b5aa765d61d8327deb882cf99" }, expectKey: "hash", expectStripped: false },
    { name: "oversized string truncated", severity: "medium", payload: { bio: "A".repeat(8000) }, expectKey: "bio", expectStripped: false },
    { name: "deep recursion bounded", severity: "low", payload: buildDeep(20), expectKey: "x", expectStripped: false },
  ];
  return cases.map((c) => {
    const t0 = Date.now();
    const out = sanitizeToolOutput(c.payload as Record<string, unknown>);
    const dt = Date.now() - t0;
    const serialized = JSON.stringify(out);
    let passed = false;
    let notes = "";
    if (c.name === "oversized string truncated") {
      const bio = (out as Record<string, string>).bio ?? "";
      passed = bio.endsWith("…[truncated]") && bio.length < 2100;
      notes = `bio length ${bio.length}`;
    } else if (c.name === "deep recursion bounded") {
      passed = serialized.includes("[REDACTED]") || serialized.length < 5000;
      notes = `output bytes ${serialized.length}`;
    } else if (c.expectStripped) {
      // The key must survive with a REDACTED value — not merely be absent, and
      // not merely have "[REDACTED]" appear somewhere in the blob.
      passed = serialized.includes(`"${c.expectKey}":"[REDACTED]"`);
      notes = passed ? `redacted ${c.expectKey}` : `LEAK: ${c.expectKey} value visible`;
    } else {
      // Pass-through contract for investigation targets: the key survives AND
      // its value is untouched. Over-redaction is a real failure here — a
      // breach password the analyst cannot see is a broken investigation.
      const wasRedacted = serialized.includes(`"${c.expectKey}":"[REDACTED]"`);
      passed = !wasRedacted && serialized.includes(`"${c.expectKey}":`);
      notes = wasRedacted
        ? `OVER-REDACTED: ${c.expectKey} is an OSINT target and must reach the investigator`
        : `passed through ${c.expectKey}`;
    }
    return {
      category: "prompt_injection",
      name: c.name,
      passed,
      severity: c.severity,
      input_snippet: SHORT(JSON.stringify(c.payload)),
      output_snippet: SHORT(serialized),
      notes,
      duration_ms: dt,
    };
  });
}

function buildDeep(n: number): Record<string, unknown> {
  let obj: Record<string, unknown> = { x: "leaf" };
  for (let i = 0; i < n; i++) obj = { x: obj };
  return obj;
}

function runSsrfTests(): TestResult[] {
  const cases: { name: string; severity: TestResult["severity"]; url: string; shouldBlock: boolean }[] = [
    { name: "AWS metadata IP", severity: "critical", url: "http://169.254.169.254/latest/meta-data/", shouldBlock: true },
    { name: "GCP metadata hostname", severity: "critical", url: "http://metadata.google.internal/", shouldBlock: true },
    { name: "IPv4 loopback", severity: "critical", url: "http://127.0.0.1:8080/admin", shouldBlock: true },
    { name: "localhost literal", severity: "critical", url: "http://localhost/", shouldBlock: true },
    { name: "IPv6 loopback", severity: "high", url: "http://[::1]/", shouldBlock: true },
    { name: "RFC1918 10/8", severity: "high", url: "http://10.0.0.5/", shouldBlock: true },
    { name: "RFC1918 192.168/16", severity: "high", url: "http://192.168.1.1/", shouldBlock: true },
    { name: "RFC1918 172.16/12", severity: "high", url: "http://172.20.0.1/", shouldBlock: true },
    { name: "0.0.0.0 bind-all", severity: "high", url: "http://0.0.0.0/", shouldBlock: true },
    { name: "file:// protocol", severity: "critical", url: "file:///etc/passwd", shouldBlock: true },
    { name: "gopher:// protocol", severity: "high", url: "gopher://127.0.0.1:11211/", shouldBlock: true },
    { name: ".internal TLD", severity: "high", url: "http://api.internal/", shouldBlock: true },
    { name: "multicast 239.x", severity: "medium", url: "http://239.255.0.1/", shouldBlock: true },

    // IPv6 and shared address space. Every one of these reached the fetch
    // untouched before the guard was rewritten. Note the mapped-v4 cases are
    // written in dotted-quad form but arrive at the guard as hex
    // (`[::ffff:7f00:1]`) because `new URL()` normalizes them — which is why a
    // dotted-quad pattern for them is dead code.
    { name: "IPv4-mapped loopback", severity: "critical", url: "http://[::ffff:127.0.0.1]/", shouldBlock: true },
    { name: "IPv4-mapped AWS metadata", severity: "critical", url: "http://[::ffff:169.254.169.254]/", shouldBlock: true },
    { name: "IPv6 unique-local fc00::/7", severity: "high", url: "http://[fc00::1]/", shouldBlock: true },
    { name: "IPv6 unique-local fd00::", severity: "high", url: "http://[fd12:3456::1]/", shouldBlock: true },
    { name: "IPv6 link-local fe80::/10", severity: "critical", url: "http://[fe80::1]/", shouldBlock: true },
    { name: "IPv6 unspecified ::", severity: "high", url: "http://[::]/", shouldBlock: true },
    { name: "NAT64 well-known prefix", severity: "high", url: "http://[64:ff9b::7f00:1]/", shouldBlock: true },
    { name: "CGNAT 100.64/10 (RFC 6598)", severity: "high", url: "http://100.64.0.1/", shouldBlock: true },

    { name: "public host allowed", severity: "low", url: "https://example.com/path", shouldBlock: false },
    { name: "public IPv6 allowed", severity: "low", url: "http://[2606:4700::1111]/", shouldBlock: false },
    { name: "just outside CGNAT allowed", severity: "low", url: "http://100.128.0.1/", shouldBlock: false },
  ];
  return cases.map((c) => {
    const t0 = Date.now();
    let blocked = false;
    let err = "";
    try { assertSafeUrl(c.url); } catch (e) { blocked = true; err = (e as Error).message; }
    const dt = Date.now() - t0;
    const passed = blocked === c.shouldBlock;
    return {
      category: "ssrf",
      name: c.name,
      passed,
      severity: c.severity,
      input_snippet: c.url,
      output_snippet: blocked ? err : "allowed",
      notes: c.shouldBlock ? (blocked ? "correctly blocked" : "BYPASS: should have been blocked") : (blocked ? "false positive on public host" : "correctly allowed"),
      duration_ms: dt,
    };
  });
}

function runOversizeTests(): TestResult[] {
  const cases: { name: string; severity: TestResult["severity"]; payload: unknown; check: (out: unknown) => { passed: boolean; notes: string } }[] = [
    {
      name: "1MB string truncated",
      severity: "high",
      payload: { blob: "x".repeat(1_000_000) },
      check: (out) => {
        const blob = (out as Record<string, string>).blob ?? "";
        return { passed: blob.length < 2100 && blob.endsWith("…[truncated]"), notes: `blob length ${blob.length}` };
      },
    },
    {
      name: "1000-element array capped",
      severity: "medium",
      payload: Array.from({ length: 1000 }, (_, i) => ({ i })),
      check: (out) => {
        const arr = out as unknown[];
        return { passed: Array.isArray(arr) && arr.length <= 200, notes: `len ${Array.isArray(arr) ? arr.length : "n/a"}` };
      },
    },
    {
      name: "deeply nested object > 8 levels",
      severity: "medium",
      payload: buildDeep(15),
      check: (out) => {
        const s = JSON.stringify(out);
        return { passed: s.includes("[REDACTED]"), notes: `bytes ${s.length}` };
      },
    },
  ];
  return cases.map((c) => {
    const t0 = Date.now();
    const out = sanitizeToolOutput(c.payload as Record<string, unknown>);
    const dt = Date.now() - t0;
    const { passed, notes } = c.check(out);
    return {
      category: "oversize",
      name: c.name,
      passed,
      severity: c.severity,
      input_snippet: SHORT(JSON.stringify(c.payload).slice(0, 200)),
      output_snippet: SHORT(JSON.stringify(out)),
      notes,
      duration_ms: dt,
    };
  });
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    // F19 fail-closed: without an anon key we cannot build a user-scoped client,
    // so we cannot verify identity or the admin role. Refuse rather than fall
    // through to any privileged path.
    if (!SUPABASE_ANON_KEY) {
      console.error("[security-test-lab] ANON_KEY_MISSING: refusing request (fail-closed)");
      return new Response(
        JSON.stringify({ error: "ANON_KEY_MISSING", detail: "SUPABASE_ANON_KEY is not configured; refusing to run without user-scoped auth." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const userId = userData.user.id;

    // Admin gate
    const { data: isAdmin, error: adminErr } = await userClient.rpc("has_role", { _user_id: userId, _role: "admin" });
    if (adminErr || !isAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden: admin required" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const t0 = Date.now();
    const results: TestResult[] = [
      ...runPromptInjectionTests(),
      ...runSsrfTests(),
      ...runOversizeTests(),
    ];
    const elapsedMs = Date.now() - t0;

    const runId = crypto.randomUUID();
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const rows = results.map((r) => ({ ...r, run_id: runId, user_id: userId }));
    const { error: insertErr } = await admin.from("security_tests").insert(rows);
    if (insertErr) console.warn("[security-test-lab] insert failed:", insertErr.message);

    const summary = {
      run_id: runId,
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      by_category: ["prompt_injection", "ssrf", "oversize"].map((cat) => {
        const list = results.filter((r) => r.category === cat);
        return { category: cat, total: list.length, failed: list.filter((r) => !r.passed).length };
      }),
      critical_failures: results.filter((r) => !r.passed && r.severity === "critical").map((r) => r.name),
      elapsed_ms: elapsedMs,
      results,
    };
    return new Response(JSON.stringify(summary), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[security-test-lab] error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});