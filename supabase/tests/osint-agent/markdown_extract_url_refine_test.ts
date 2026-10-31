// markdown_extract_url_refine_test.ts — the http(s)-protocol refine must never
// let a parse THROW.
//
// `z.string().url()` is regex-based and accepts shapes that `new URL()` rejects
// (the model wrapping a URL in <angle-brackets> is the measured case). The
// refine used `new URL(u).protocol` directly, so an uncaught TypeError
// propagated out of `safeParse` — breaking the SDK's tool-call contract and
// surfacing as a crash rather than a validation error. The fix catches the
// URL constructor failure and treats it as a refine failure.
import { assert, assertFalse } from "jsr:@std/assert@^1";
import { buildTools, type ToolContext } from "../../functions/osint-agent/tool-registry.ts";

function ctx(): ToolContext {
  return {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "md-refine",
    archiveEnabled: false, detectedSeedType: "url", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
}

function markdownExtractSchema() {
  const { tools } = buildTools(ctx());
  return (tools as Record<string, { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }>)
    .markdown_extract.inputSchema;
}

// Red-first case: this used to THROW out of `safeParse` instead of returning
// `{success:false}`. The assertion we actually care about is that no exception
// escapes — the particular success/failure doesn't matter as long as it's a
// legible return value.
Deno.test("markdown_extract: safeParse never throws on an angle-bracketed URL", () => {
  const schema = markdownExtractSchema();
  let threw: unknown = null;
  let r: { success: boolean } | undefined;
  try {
    r = schema.safeParse({ url: "<https://example.com/doc.pdf>" });
  } catch (e) {
    threw = e;
  }
  assert(threw === null, `safeParse must not throw; got ${threw}`);
  assertFalse(r!.success, "angle-bracketed URL should be rejected cleanly (not thrown)");
});

Deno.test("markdown_extract: a plain http(s) URL still validates", () => {
  const schema = markdownExtractSchema();
  const r = schema.safeParse({ url: "https://example.com/doc.pdf" });
  assert(r.success, "a plain https URL must pass the refine");
});

Deno.test("markdown_extract: non-http(s) protocols are still rejected (ftp, data, file)", () => {
  const schema = markdownExtractSchema();
  for (const u of ["ftp://example.com/x", "data:text/plain,hi", "file:///etc/passwd"]) {
    const r = schema.safeParse({ url: u });
    assertFalse(r.success, `${u} should be rejected`);
  }
});
