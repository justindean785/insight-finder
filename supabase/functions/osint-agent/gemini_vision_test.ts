import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { gemini_vision, runGeminiVision } from "./tools/gemini_vision.ts";
import { classifyToolOutcome } from "./tool-outcome.ts";

// gemini_vision wiring + outcome contract. The tool reads GEMINI_API_KEY at CALL
// time, so we set it only INSIDE each test (never at module top-level) — setting
// it at import would pollute env.ts's boot-time fallback-provider selection for
// providers_test/fallback_repoint in the shared `deno test` process.
// globalThis.fetch is stubbed so no network is hit.
type ExecTool = { execute: (input: unknown, opts: unknown) => Promise<Record<string, unknown>> };
const exec = (input: unknown): Promise<Record<string, unknown>> =>
  (gemini_vision as unknown as ExecTool).execute(input, {});

const TINY_B64 = "aGVsbG8="; // "hello" — content is irrelevant; fetch is stubbed.

function geminiResponse(status: number, modelText: string): Response {
  const body = status >= 200 && status < 300
    ? { candidates: [{ content: { parts: [{ text: modelText }] } }] }
    : { error: { message: modelText } };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Set GEMINI_API_KEY for the duration of fn only, then restore. */
async function withGeminiKey(fn: () => Promise<void>) {
  const orig = Deno.env.get("GEMINI_API_KEY");
  Deno.env.set("GEMINI_API_KEY", "gv-test-key");
  try { await fn(); }
  finally { if (orig === undefined) Deno.env.delete("GEMINI_API_KEY"); else Deno.env.set("GEMINI_API_KEY", orig); }
}

async function withStubbedGemini(
  status: number,
  modelText: string,
  fn: () => Promise<void>,
) {
  const orig = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("generativelanguage.googleapis.com")) {
      return Promise.resolve(geminiResponse(status, modelText));
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as typeof fetch;
  try { await withGeminiKey(fn); } finally { globalThis.fetch = orig; }
}

Deno.test("gemini_vision image mode: returns attributes/watermarks/handles, lead-tier provenance", async () => {
  const modelJson = JSON.stringify({
    visible_text: "BOOKING #12345",
    watermarks: ["bustednewspaper.com"],
    handles: ["@big95"],
    attributes: ["male", "dark hoodie", "neutral background"],
    scene: "a booking mugshot",
    confidence: 80,
  });
  await withStubbedGemini(200, "```json\n" + modelJson + "\n```", async () => {
    const r = await exec({ mode: "image", base64: TINY_b64Safe(), mime_type: "image/jpeg" });
    assertEquals(r.ok, true);
    assertEquals(r.mode, "image");
    // Never Confirmed on a single pass — provenance is the lead-tier anchor.
    assertEquals(r.provenance, "inferred_from_vision");
    const res = r.result as Record<string, unknown>;
    assertEquals((res.watermarks as string[])[0], "bustednewspaper.com");
    assert((res.handles as string[]).includes("@big95"));
    // attributes only — no identity assertion is present as a field.
    assert(Array.isArray(res.attributes));
    assertEquals(classifyToolOutcome(r.error ?? null, r.status ?? null), "ok");
  });
});

Deno.test("gemini_vision document mode: extracts text + selectors (reads the PDF, not the URL)", async () => {
  const modelJson = JSON.stringify({
    extracted_text: "Contact: big95music@gmail.com IG @3gfgct phone 559-772-7112",
    tables: [],
    selectors: ["big95music@gmail.com", "@3gfgct", "559-772-7112"],
    confidence: 72,
  });
  await withStubbedGemini(200, modelJson, async () => {
    const r = await exec({ mode: "document", base64: TINY_b64Safe(), mime_type: "application/pdf" });
    assertEquals(r.ok, true);
    assertEquals(r.mode, "document");
    assertEquals(r.provenance, "extracted_from_document");
    const res = r.result as Record<string, unknown>;
    assert((res.selectors as string[]).includes("@3gfgct"));
    assertEquals(classifyToolOutcome(r.error ?? null, r.status ?? null), "ok");
  });
});

Deno.test("gemini_vision: no input (no url/base64) → skip, not a crash", async () => {
  await withGeminiKey(async () => {
    const r = await runGeminiVision({ mode: "image" }, undefined);
    assert(!r.ok);
    assert(typeof r.error === "string" && (r.error as string).includes("no input"));
  });
});

Deno.test("gemini_vision: Gemini non-2xx → failed outcome", async () => {
  await withStubbedGemini(500, "internal error", async () => {
    const r = await exec({ mode: "document", base64: TINY_b64Safe() });
    assertEquals(r.ok, false);
    assertEquals(classifyToolOutcome(r.error, r.status), "failed");
  });
});

Deno.test("gemini_vision: unparseable model reply → failed with raw_text", async () => {
  await withStubbedGemini(200, "sorry, I can't help with that", async () => {
    const r = await exec({ mode: "image", base64: TINY_b64Safe() });
    assertEquals(r.ok, false);
    assert(typeof r.raw_text === "string");
  });
});

// base64 with a data: URI prefix must be accepted (stripped before send).
function TINY_b64Safe(): string {
  return "data:image/jpeg;base64," + TINY_B64;
}
