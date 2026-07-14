// deepseek_health_obs_test.ts — DeepSeek provider-observability in ?health=1.
//
// Makes the DeepSeek STOP gate verifiable at the health endpoint: an explicit
// selected_provider + selected_model, a checks.deepseek reachability probe in
// NON-THINKING mode, and role labels that never call MiniMax "active" when DeepSeek
// is the selected orchestrator. All units are dependency-injected so no network runs.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  checkDeepseek,
  resolveSelectedOrchestrator,
  providerRole,
} from "./health-handler.ts";

// ---- checks.deepseek probe -------------------------------------------------------

Deno.test("checkDeepseek: missing key → ok:false reason:missing_key (no network)", async () => {
  let fetched = false;
  const r = await checkDeepseek({ hasKey: false, doFetch: (() => { fetched = true; return Promise.reject(new Error("should not fetch")); }) as unknown as typeof fetch });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "missing_key");
  assertEquals(fetched, false, "a missing key must short-circuit before any network call");
});

Deno.test("checkDeepseek: probes in NON-THINKING mode with a tiny token budget", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const fakeFetch = ((_url: string, init: { body?: string }) => {
    capturedBody = JSON.parse(init.body ?? "{}");
    return Promise.resolve({ ok: true, status: 200 } as Response);
  }) as unknown as typeof fetch;
  const r = await checkDeepseek({ hasKey: true, apiKey: "k", model: "deepseek-v4-pro", doFetch: fakeFetch });
  assertEquals(r.ok, true);
  assert(capturedBody, "the probe must issue a request");
  const b = capturedBody as Record<string, unknown>;
  assertEquals((b.thinking as { type?: string })?.type, "disabled", "probe MUST disable thinking mode");
  assertEquals(b.model, "deepseek-v4-pro");
  assert((b.max_tokens as number) <= 8, "probe must stay a cheap canary");
});

Deno.test("checkDeepseek: upstream non-2xx → preflight_failed with status", async () => {
  const fakeFetch = (() => Promise.resolve({ ok: false, status: 401 } as Response)) as unknown as typeof fetch;
  const r = await checkDeepseek({ hasKey: true, apiKey: "k", doFetch: fakeFetch });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "preflight_failed");
  assert(r.detail?.includes("401"), "the upstream status must be visible");
});

Deno.test("checkDeepseek: network throw → preflight_failed (visible, not masked)", async () => {
  const fakeFetch = (() => Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;
  const r = await checkDeepseek({ hasKey: true, apiKey: "k", doFetch: fakeFetch });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "preflight_failed");
});

// ---- resolveSelectedOrchestrator: selected_provider + selected_model -------------

Deno.test("selection: pinned deepseek → deepseek + deepseek model", () => {
  const s = resolveSelectedOrchestrator({ pin: "deepseek", deepseek: true, minimax: true, grok: false, openadapter: false });
  assertEquals(s.provider, "deepseek");
  assertEquals(s.reason, "pinned");
  assertEquals(s.model, "deepseek-v4-pro");
});

Deno.test("selection: no pin but DeepSeek keyed → deepseek by default", () => {
  const s = resolveSelectedOrchestrator({ pin: "", deepseek: true, minimax: true, grok: false, openadapter: false });
  assertEquals(s.provider, "deepseek");
  assertEquals(s.reason, "default-deepseek");
  assertEquals(s.model, "deepseek-v4-pro");
});

Deno.test("selection: DeepSeek not configured → falls back to MiniMax (+ minimax model)", () => {
  const s = resolveSelectedOrchestrator({ pin: "", deepseek: false, minimax: true, grok: false, openadapter: false });
  assertEquals(s.provider, "minimax");
  assert(s.model.length > 0, "a minimax model id must be reported");
});

Deno.test("selection: explicit minimax pin wins even with DeepSeek keyed", () => {
  const s = resolveSelectedOrchestrator({ pin: "minimax", deepseek: true, minimax: true, grok: false, openadapter: false });
  assertEquals(s.provider, "minimax");
  assertEquals(s.reason, "pinned");
});

// ---- role labeling: MiniMax is never "active" when DeepSeek is selected ----------

Deno.test("role: when DeepSeek is selected, deepseek=active and minimax=fallback", () => {
  assertEquals(providerRole("deepseek", "deepseek"), "active");
  assertEquals(providerRole("deepseek", "minimax"), "fallback", "MiniMax must NOT be active when DeepSeek is selected");
});

Deno.test("role: when MiniMax is selected, minimax=active and deepseek=fallback", () => {
  assertEquals(providerRole("minimax", "minimax"), "active");
  assertEquals(providerRole("minimax", "deepseek"), "fallback");
});
