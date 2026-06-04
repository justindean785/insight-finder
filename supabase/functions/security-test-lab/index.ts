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
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ---------- mirrored defenses ----------
const SENSITIVE_KEY_RE =
  /^(password|passwd|pwd|hash|salt|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|cookie|session|authorization|ssn|sin|dob|date[_-]?of[_-]?birth|cc|credit[_-]?card|cvv|cvc|otp|mfa)$/i;
const REDACTED = "[REDACTED]";
function sanitizeToolOutput<T>(input: T, maxStr = 2000, depth = 0): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (input == null) return input;
  if (typeof input === "string") {
    return (input.length > maxStr ? input.slice(0, maxStr) + "…[truncated]" : input) as unknown as T;
  }
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.slice(0, 200).map((v) => sanitizeToolOutput(v, maxStr, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) { out[k] = REDACTED; continue; }
    out[k] = sanitizeToolOutput(v, maxStr, depth + 1);
  }
  return out as unknown as T;
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("[::1")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
  }
  return false;
}
function assertSafeUrl(rawUrl: string): URL {
  const u = new URL(rawUrl);
  if (!/^https?:$/.test(u.protocol)) throw new Error(`blocked: protocol ${u.protocol}`);
  if (isPrivateHost(u.hostname)) throw new Error(`blocked: private/internal host ${u.hostname}`);
  return u;
}

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
    { name: "password key stripped", severity: "critical", payload: { user: "alice", password: "hunter2" }, expectKey: "password", expectStripped: true },
    { name: "api_key key stripped", severity: "critical", payload: { service: "x", api_key: "sk-live-abc123" }, expectKey: "api_key", expectStripped: true },
    { name: "ssn key stripped", severity: "critical", payload: { name: "Bob", ssn: "123-45-6789" }, expectKey: "ssn", expectStripped: true },
    { name: "dob key stripped", severity: "high", payload: { dob: "1990-01-01" }, expectKey: "dob", expectStripped: true },
    { name: "nested token stripped", severity: "critical", payload: { account: { profile: { token: "bearer-xyz" } } }, expectKey: "token", expectStripped: true },
    { name: "session in array stripped", severity: "high", payload: [{ session: "abc" }, { session: "def" }], expectKey: "session", expectStripped: true },
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
      passed = !serialized.includes("hunter2")
        && !serialized.includes("sk-live-abc123")
        && !serialized.includes("123-45-6789")
        && !serialized.includes("1990-01-01")
        && !serialized.includes("bearer-xyz")
        && !serialized.includes("abc")
        || serialized.includes("[REDACTED]");
      // Stricter: key must be present with REDACTED value
      passed = JSON.stringify(out).includes(`"${c.expectKey}":"[REDACTED]"`);
      notes = passed ? `redacted ${c.expectKey}` : `LEAK: ${c.expectKey} value visible`;
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
    { name: "public host allowed", severity: "low", url: "https://example.com/path", shouldBlock: false },
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