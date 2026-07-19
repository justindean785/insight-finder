import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractFindings,
  extractStepFindings,
  normalizeFinding,
  AUTO_PERSIST_TOOL_DENYLIST,
} from "./auto-persist-findings.ts";

Deno.test("normalizeFinding rejects invalid values", () => {
  assertEquals(normalizeFinding("url", "not-a-url"), null);
  assertEquals(normalizeFinding("email", "not-an-email"), null);
  assertEquals(normalizeFinding("secret", "anything"), null);
});

Deno.test("normalizeFinding strips utm params from url", () => {
  const n = normalizeFinding("url", "https://example.com/a?utm_source=x&foo=1");
  assertEquals(n?.value, "https://example.com/a?foo=1");
});

Deno.test("extractFindings skips denylisted tools", () => {
  for (const t of AUTO_PERSIST_TOOL_DENYLIST) {
    assertEquals(extractFindings(t, { ok: true, citations: [{ url: "https://ex.com" }] }), []);
  }
});

Deno.test("extractFindings pulls perplexity citations", () => {
  const out = extractFindings("perplexity_search_wrap", {
    ok: true,
    citations: [{ url: "https://ex.com/1" }, "https://ex.com/2", { url: "junk" }],
  });
  assertEquals(out.length, 2);
  assertEquals(out[0].kind, "url");
});

Deno.test("extractFindings pulls hibp breaches", () => {
  const out = extractFindings("hibp_check", {
    ok: true,
    data: { breaches: [{ Name: "LinkedIn" }, { name: "Adobe" }] },
  });
  assertEquals(out.length, 2);
  assertEquals(out[0], { kind: "breach", value: "LinkedIn", context: { tool: "hibp_check", via: "hibp_style" }, rawConfidence: 55 });
});

Deno.test("extractFindings handles github_user", () => {
  const out = extractFindings("github_user", {
    ok: true,
    user: { login: "octocat", html_url: "https://github.com/octocat", email: "OCT@example.com", blog: "https://oct.example" },
    repos: [{ url: "https://github.com/octocat/repo" }],
  });
  const kinds = out.map((f) => f.kind).sort();
  assert(kinds.includes("github_account"));
  assert(kinds.includes("email"));
  assert(kinds.includes("url"));
  // email is normalized to lowercase
  assertEquals(out.find((f) => f.kind === "email")?.value, "oct@example.com");
});

Deno.test("extractFindings skips explicit tool errors", () => {
  assertEquals(extractFindings("hibp_check", { ok: false, error: "bad key" }), []);
  assertEquals(extractFindings("hibp_check", { error: "boom" }), []);
});

Deno.test("extractStepFindings dedups across tool calls", () => {
  const results = [
    { toolName: "perplexity_search_wrap", output: { ok: true, citations: [{ url: "https://ex.com/a" }] } },
    { toolName: "perplexity_search_wrap", output: { ok: true, citations: [{ url: "https://ex.com/a" }, { url: "https://ex.com/b" }] } },
  ];
  const out = extractStepFindings(results);
  assertEquals(out.length, 2);
});

Deno.test("extractStepFindings caps per-step at 60", () => {
  const citations: string[] = [];
  for (let i = 0; i < 200; i++) citations.push(`https://ex.com/${i}`);
  const results = [{ toolName: "perplexity_search_wrap", output: { ok: true, citations } }];
  const out = extractStepFindings(results);
  assert(out.length <= 60);
});
