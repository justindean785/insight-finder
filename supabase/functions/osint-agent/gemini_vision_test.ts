import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { gemini_vision, runGeminiVision, sniffKind } from "./tools/gemini_vision.ts";
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

// --- sniffKind: the 4096-byte probe boundary must not misclassify valid UTF-8 ---
//
// Regression for the live defect: TextDecoder("utf-8", {fatal:true}).decode(probe)
// threw whenever a multibyte character's bytes straddled the 4096-byte cut point,
// so a perfectly valid text file was sniffed "binary" and later shipped to Gemini
// as an inline_data PDF. The fix passes {stream:true} so a truncated trailing
// sequence is buffered instead of rejected; a genuinely invalid sequence must
// still fail closed.

const GENERIC_MIME = "application/octet-stream"; // bypasses IMAGE_MIME/DOC_MIME/TEXT_MIME so sniffKind actually probes bytes

/** ASCII 'A' prefix + a multibyte char at `prefixLen` + ASCII 'B' suffix. */
function buildStraddling(prefixLen: number, charBytes: number[]): Uint8Array {
  const char = new Uint8Array(charBytes);
  const out = new Uint8Array(prefixLen + char.length + 256);
  out.fill(0x41, 0, prefixLen); // 'A'
  out.set(char, prefixLen);
  out.fill(0x42, prefixLen + char.length); // 'B'
  return out;
}

const EURO_3BYTE = [0xe2, 0x82, 0xac]; // U+20AC, 3-byte UTF-8
const EMOJI_4BYTE = [0xf0, 0x9f, 0x98, 0x80]; // U+1F600, 4-byte UTF-8
const CJK_3BYTE = [0xe4, 0xb8, 0xad]; // U+4E2D "中", 3-byte UTF-8

Deno.test("sniffKind: 3-byte UTF-8 char straddling the 4096 probe boundary -> text", () => {
  // prefixLen 4094/4095 previously truncated the euro sign mid-sequence and threw.
  for (let prefixLen = 4090; prefixLen <= 4098; prefixLen++) {
    const bytes = buildStraddling(prefixLen, EURO_3BYTE);
    assertEquals(sniffKind(bytes, GENERIC_MIME), "text", `prefixLen=${prefixLen}`);
  }
});

Deno.test("sniffKind: 4-byte UTF-8 char straddling the 4096 probe boundary -> text", () => {
  // prefixLen 4093-4095 previously truncated the emoji mid-sequence and threw.
  for (let prefixLen = 4089; prefixLen <= 4098; prefixLen++) {
    const bytes = buildStraddling(prefixLen, EMOJI_4BYTE);
    assertEquals(sniffKind(bytes, GENERIC_MIME), "text", `prefixLen=${prefixLen}`);
  }
});

Deno.test("sniffKind: CJK text across every byte alignment near the boundary -> text", () => {
  // A run of CJK characters guarantees SOME character's bytes straddle byte 4096
  // for most alignments; sweep the alignment by varying an ASCII pad so the
  // boundary falls at every possible offset within a 3-byte character.
  for (let pad = 0; pad < 9; pad++) {
    const cjkRun: number[] = [];
    for (let i = 0; i < 200; i++) cjkRun.push(...CJK_3BYTE);
    const prefix = new Uint8Array(4096 - 300 + pad).fill(0x41);
    const bytes = new Uint8Array(prefix.length + cjkRun.length);
    bytes.set(prefix, 0);
    bytes.set(cjkRun, prefix.length);
    assertEquals(sniffKind(bytes, GENERIC_MIME), "text", `pad=${pad}`);
  }
});

Deno.test("sniffKind: random binary bytes -> binary", () => {
  const bytes = new Uint8Array(6000);
  crypto.getRandomValues(bytes);
  // Force an invalid UTF-8 lead byte so the case can't flake true by chance.
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  assertEquals(sniffKind(bytes, GENERIC_MIME), "binary");
});

Deno.test("sniffKind: embedded NUL byte (not at the probe boundary) -> binary", () => {
  const bytes = new Uint8Array(5000).fill(0x41);
  bytes[500] = 0x00;
  assertEquals(sniffKind(bytes, GENERIC_MIME), "binary");
});

Deno.test("sniffKind: UTF-16LE encoded text -> binary (existing intended classification)", () => {
  const s = "Hello world, this is plain ASCII text. ".repeat(150);
  const bytes = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    bytes[i * 2] = s.charCodeAt(i);
    bytes[i * 2 + 1] = 0x00; // UTF-16LE's dense NUL bytes trip the NUL rejection
  }
  assertEquals(sniffKind(bytes, GENERIC_MIME), "binary");
});

Deno.test("sniffKind: genuinely malformed UTF-8 away from the boundary still fails closed -> binary", () => {
  // stream:true must only forgive a truncated TRAILING sequence, never an
  // actually-invalid sequence sitting in the middle of the probe.
  const bytes = new Uint8Array(5000).fill(0x41);
  bytes[500] = 0xc0; // overlong-encoding lead byte, invalid UTF-8
  bytes[501] = 0x80;
  assertEquals(sniffKind(bytes, GENERIC_MIME), "binary");
});
