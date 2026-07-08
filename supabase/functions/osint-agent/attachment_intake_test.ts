import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseAttachments, isImageAttachment, isDocAttachment, runAttachmentIntake } from "./attachment-intake.ts";

// runAttachmentIntake reads GEMINI_API_KEY at CALL time, so we set it only INSIDE
// the read tests (never at module top-level) — setting it at import would pollute
// env.ts's boot-time fallback-provider selection for providers_test/fallback_repoint.
const GEMINI_HOST = "generativelanguage.googleapis.com";
type Row = Record<string, unknown>;

async function withGeminiKey(fn: () => Promise<void>) {
  const orig = Deno.env.get("GEMINI_API_KEY");
  Deno.env.set("GEMINI_API_KEY", "gv-test-key");
  try { await fn(); }
  finally { if (orig === undefined) Deno.env.delete("GEMINI_API_KEY"); else Deno.env.set("GEMINI_API_KEY", orig); }
}

Deno.test("parseAttachments: splits the composer 'Attached files:' block (signed URLs intact)", () => {
  const text =
    "look at this\n\nAttached files:\n" +
    "- [Morris-mugshot.jpg](https://sb.co/storage/v1/object/sign/chat-uploads/abc?token=xyz) (image/jpeg, 1.2 MB)\n" +
    "- [PDF Export 8.pdf](https://sb.co/storage/v1/object/sign/chat-uploads/def?token=qrs) (application/pdf, 400 KB)";
  const atts = parseAttachments(text);
  assertEquals(atts.length, 2);
  assertEquals(atts[0].name, "Morris-mugshot.jpg");
  assert(atts[0].url.includes("token=xyz"));
  assert(isImageAttachment(atts[0]));
  assert(isDocAttachment(atts[1]));
  assert(!isImageAttachment(atts[1]));
});

function stubDeps(sink: Row[]) {
  return {
    supabase: { from: (_t: string) => ({ insert: (rows: unknown[]) => { sink.push(...(rows as Row[])); return Promise.resolve({ error: null }); } }) },
    userId: "u", threadId: "t-intake",
  };
}

function userMsg(text: string) {
  return [{ role: "user", parts: [{ type: "text", text }] }] as unknown as Parameters<typeof runAttachmentIntake>[0];
}

Deno.test("runAttachmentIntake: image → records watermark(domain)+handle, attributes-only summary", async () => {
  const orig = globalThis.fetch;
  const sink: Row[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(GEMINI_HOST)) {
      const modelJson = JSON.stringify({
        visible_text: "BOOKING 12345", watermarks: ["bustednewspaper.com"], handles: ["@big95"],
        attributes: ["male", "dark hoodie"], scene: "a booking mugshot", confidence: 80,
      });
      return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: modelJson }] } }] }), { status: 200 }));
    }
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/jpeg" } }));
  }) as typeof fetch;
  try {
    await withGeminiKey(async () => {
      const res = await runAttachmentIntake(
        userMsg("who is this?\n\nAttached files:\n- [mug.jpg](https://sb.co/x.jpg) (image/jpeg, 1 MB)"),
        stubDeps(sink),
      );
      assertEquals(res.ran, true);
      assertEquals(res.attachments_read, 1);
      // watermark domain + handle both recorded as lead-tier
      const kinds = sink.map((r) => r.kind).sort();
      assert(kinds.includes("domain"), "watermark domain recorded");
      assert(kinds.includes("username"), "handle recorded");
      for (const r of sink) {
        const meta = r.metadata as Record<string, unknown>;
        assertEquals(meta.provenance, "inferred_from_vision");
        assert((r.confidence as number) <= 55, "vision artifacts are lead-tier (≤55)");
      }
      assert(res.summary.includes("ATTRIBUTES ONLY"), "summary must state attributes-only (no face→name)");
      assert(res.summary.includes("bustednewspaper.com"));
    });
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("runAttachmentIntake: PDF → reads document, records classified selectors (extracted_from_document)", async () => {
  const orig = globalThis.fetch;
  const sink: Row[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(GEMINI_HOST)) {
      const modelJson = JSON.stringify({
        extracted_text: "Contact big95music@gmail.com or call 559-772-7112, IG @3gfgct",
        tables: [], selectors: ["big95music@gmail.com", "559-772-7112", "@3gfgct"], confidence: 72,
      });
      return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: modelJson }] } }] }), { status: 200 }));
    }
    return Promise.resolve(new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf" } }));
  }) as typeof fetch;
  try {
    await withGeminiKey(async () => {
      const res = await runAttachmentIntake(
        userMsg("Attached files:\n- [export.pdf](https://sb.co/export.pdf) (application/pdf, 1 MB)"),
        stubDeps(sink),
      );
      assertEquals(res.ran, true);
      const kinds = sink.map((r) => r.kind).sort();
      assert(kinds.includes("email"));
      assert(kinds.includes("phone"));
      assert(kinds.includes("username"));
      for (const r of sink) assertEquals((r.metadata as Record<string, unknown>).provenance, "extracted_from_document");
      assert(res.summary.includes("DOCUMENT"));
    });
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("runAttachmentIntake: no attachments → no-op", async () => {
  const res = await runAttachmentIntake(userMsg("just a text question, no files"), stubDeps([]));
  assertEquals(res.ran, false);
  assertEquals(res.artifacts_inserted, 0);
});
