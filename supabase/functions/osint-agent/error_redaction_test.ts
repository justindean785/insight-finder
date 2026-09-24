// Error hygiene (audit 2026-09-24, F-7b/c/d). Synthetic keys only.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { configuredSecrets, redactErrorMessage } from "./lib/redact-error.ts";
import { orchestratorFaultResponse } from "./lib/orchestrator-fault.ts";

// Shaped like a key with no known prefix (Z.AI / MiniMax style), so only the
// configured-value layer can catch it.
const OPAQUE_KEY = "3f9a0c1b2d4e5f60718293a4b5c6d7e8.ZxQw1234abcd";
const SK_KEY = "sk-" + "synthetic0123456789abcdef";

Deno.test("catch-all: a provider error echoing our key reaches neither the 500 body nor the log", async () => {
  const logged: string[] = [];
  const err = new Error(`401 Incorrect API key provided: ${SK_KEY}`);
  const res = orchestratorFaultResponse(err, { "x-cors": "1" }, (l) => logged.push(l));
  const body = await res.text();
  assertEquals(res.status, 500);
  assert(!body.includes(SK_KEY), "response body leaks the key");
  assertEquals(logged.length, 1);
  assert(!logged[0].includes(SK_KEY), "log line leaks the key");
  assert(!logged[0].includes("at "), "log line must not carry a stack trace");
  const line = JSON.parse(logged[0]);
  assertEquals(line.event, "orchestrator_fault");
  assertEquals(line.message, JSON.parse(body).detail, "log and response carry the same redacted text");
});

Deno.test("catch-all: the logged message is bounded", () => {
  const logged: string[] = [];
  orchestratorFaultResponse(new Error("x".repeat(5_000)), {}, (l) => logged.push(l));
  assert(JSON.parse(logged[0]).message.length <= 300);
});

Deno.test("redactErrorMessage: a configured key of ANY shape is redacted by value", () => {
  const out = redactErrorMessage(`upstream said: invalid key ${OPAQUE_KEY} (code 1113)`, [OPAQUE_KEY]);
  assert(!out.includes(OPAQUE_KEY));
  assert(out.includes("(code 1113)"), "the rest of the message survives");
});

Deno.test("configuredSecrets: only *_KEY/*_TOKEN/*_SECRET vars of 16+ chars, never throws", () => {
  const env = () => ({
    GLM_API_KEY: OPAQUE_KEY,
    GITHUB_API_TOKEN: "ghp_" + "a".repeat(20),
    SHORT_KEY: "abc",
    DEEPSEEK_BASE_URL: "https://api.example.test/v1/long-enough-value",
    REVEAL_BREACH_DATA: "true",
  });
  const got = configuredSecrets(env);
  assertEquals(got.sort(), [OPAQUE_KEY, "ghp_" + "a".repeat(20)].sort());
  assertEquals(configuredSecrets(() => { throw new Error("NotCapable"); }), []);
});

Deno.test("redactErrorMessage: shape patterns cover prefixed keys, labelled keys and query strings", () => {
  const cases: Array<[string, string]> = [
    [`auth Bearer eyJhbGci.x.y`, "eyJhbGci"],
    [SK_KEY, SK_KEY],
    [`xai-KEY999abc`, "xai-KEY999abc"],
    [`key AIzaSyFAKE_key-1`, "AIzaSyFAKE_key-1"],
    [`x-api-key: 3f9a0c1b2d4e5f60`, "3f9a0c1b2d4e5f60"],
    [`{"apiKey":"k_live_998877"}`, "k_live_998877"],
    [`GET https://h.example.test/v1?q=a&api_key=zz_123456&x=1`, "zz_123456"],
    [`Authorization: Basic dXNlcjpwYXNz`, "dXNlcjpwYXNz"],
  ];
  for (const [input, leak] of cases) assert(!redactErrorMessage(input, []).includes(leak), input);
  assertEquals(redactErrorMessage("plain failure: HTTP 503", []), "plain failure: HTTP 503");
});

Deno.test("wiring: the catch-all goes through orchestratorFaultResponse and never logs the raw exception", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(src.includes("return orchestratorFaultResponse(e, corsHeaders);"), "catch-all path");
  assert(!src.includes('console.error("osint-agent error", e)'), "raw exception log must be gone");
  assert(!/detail:\s*e\.message|detail:\s*String\(e\)/.test(src), "no raw error text in a response body");
});

Deno.test("wiring: the stream onError log line and client message are both redacted", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(src.includes("message: redactErrorMessage(msg).slice(0, 600),"), "stream log line");
  assert(!src.includes("message: msg.slice(0, 600)"), "raw stream log line must be gone");
  assert(src.includes('return redactErrorMessage(m).slice(0, 300) || "Provider stream error";'), "stream client message");
});

Deno.test("wiring: telemetry and the tool-usage logger use the ONE shared redactor", async () => {
  const tel = await Deno.readTextFile(new URL("./telemetry.ts", import.meta.url));
  const cache = await Deno.readTextFile(new URL("./cache.ts", import.meta.url));
  for (const [name, src] of [["telemetry.ts", tel], ["cache.ts", cache]]) {
    assert(src.includes('import { redactErrorMessage } from "./lib/redact-error.ts";'), `${name} imports it`);
    assert(!/\.replace\(\/sk-\[/.test(src), `${name} must not carry its own copy`);
  }
});

Deno.test("wiring: the zero-artifact log event records the seed's kind and length, not its text", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(!src.includes("seed: seedValueRaw.slice("), "raw seed text must not be logged");
  assert(src.includes('seed_kind: detectSeedServer(seedValueRaw)?.kind ?? "unknown"'));
});

Deno.test("health: checks.error_redaction is reported", async () => {
  const src = await Deno.readTextFile(new URL("./health-handler.ts", import.meta.url));
  assert(src.includes("r.checks.error_redaction = { ok: true,"));
});
