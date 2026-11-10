// attachment_seed_test.ts — the case seed is what the analyst typed, never the
// composer's "Attached files:" block.
//
// Before this, an upload-started case stored a signed storage URL (cut mid-token)
// in threads.title and threads.seed_value, and classified as `other` whatever the
// analyst had typed above the upload. All values here are synthetic.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachmentSeedSelfTest,
  attachmentTitle,
  deriveThreadSeed,
  hasSeedAttachments,
  parseAttachments,
  splitSeedText,
} from "../../functions/osint-agent/lib/attachment-block.ts";
import { parseAttachments as reExported } from "../../functions/osint-agent/attachment-intake.ts";
import { detectSeedServer, formatThreadTitle } from "../../functions/osint-agent/validation.ts";

const URL_A = "https://storage.example.com/storage/v1/object/sign/chat-uploads/a.pdf?token=SYNTHETICTOKENAAAA";
const URL_B = "https://storage.example.com/storage/v1/object/sign/chat-uploads/b.png?token=SYNTHETICTOKENBBBB";
const ONE = `Attached files:\n- [scan.pdf](${URL_A}) (application/pdf, 1.0 MB)`;
const TWO = `${ONE}\n- [photo.png](${URL_B}) (image/png, 300 KB)`;
const leaks = (s: string) => /token=|\/object\/sign\/|https?:\/\/|storage\.example/i.test(s);

function withSwitch(fn: () => void) {
  const orig = Deno.env.get("ATTACHMENT_SEED_STRIP_DISABLED");
  Deno.env.set("ATTACHMENT_SEED_STRIP_DISABLED", "true");
  try { fn(); }
  finally {
    if (orig === undefined) Deno.env.delete("ATTACHMENT_SEED_STRIP_DISABLED");
    else Deno.env.set("ATTACHMENT_SEED_STRIP_DISABLED", orig);
  }
}

Deno.test("upload-only: the title names the file, the seed is empty, nothing holds a URL", () => {
  const one = deriveThreadSeed(ONE, { classify: true });
  assertEquals(one.title, "Attachment: scan.pdf");
  assertEquals(one.seedValue, "");
  assertEquals(one.detected?.kind, "other", "same routing these cases always had");
  const two = deriveThreadSeed(TWO, { classify: true });
  assertEquals(two.title, "Attachment: scan.pdf +1");
  assertEquals(two.seedValue, "");
  assert(!leaks(one.title) && !leaks(two.title));
});

Deno.test("typed person name + upload: the seed is the name and it classifies as a person", () => {
  const d = deriveThreadSeed(`Jordan Example\n\n${TWO}`, { classify: true });
  assertEquals(d.detected?.kind, "person");
  assertEquals(d.seedValue, "Jordan Example");
  assertEquals(d.title, "Person: Jordan Example");
  assert(!leaks(d.title) && !leaks(d.seedValue));
});

Deno.test("typed email + upload classifies as the email, not `other`", () => {
  const d = deriveThreadSeed(`jordan@example.com\n\n${ONE}`, { classify: true });
  assertEquals(d.detected?.kind, "email");
  assertEquals(d.seedValue, "jordan@example.com");
});

Deno.test("no attachment: byte-identical to the old derivation", () => {
  for (const text of ["Jordan Example", "jordan@example.com", "what does this tool do?", "+15550100199"]) {
    const d = deriveThreadSeed(text, { classify: true });
    const old = detectSeedServer(text);
    assertEquals(d.detected, old, text);
    assertEquals(d.title, formatThreadTitle(text, old), text);
    assertEquals(d.seedValue, text.slice(0, 200), text);
    assertEquals(hasSeedAttachments(text), false, text);
  }
});

Deno.test("prose that only mentions the marker is not stripped", () => {
  const text = "Why does the composer write Attached files: under my message?";
  assertEquals(splitSeedText(text), { typed: text, attachments: [] });
  assertEquals(deriveThreadSeed(text, { classify: true }).seedValue, text);
});

Deno.test("splitSeedText: typed text is trimmed and the attachments are returned", () => {
  const s = splitSeedText(`  Jordan Example \n\n${TWO}`);
  assertEquals(s.typed, "Jordan Example");
  assertEquals(s.attachments.map((a) => a.name), ["scan.pdf", "photo.png"]);
  assertEquals(splitSeedText(ONE).typed, "");
  assertEquals(hasSeedAttachments(ONE), true);
});

Deno.test("a signed URL of realistic length (~700 chars) is still split off whole", () => {
  const longUrl = `https://storage.example.com/storage/v1/object/sign/chat-uploads/a.pdf?token=${"SYNTHETIC".repeat(75)}`;
  assert(longUrl.length > 700);
  const d = deriveThreadSeed(`jordan@example.com\n\nAttached files:\n- [scan.pdf](${longUrl}) (application/pdf, 11.4 MB)`, { classify: true });
  assertEquals(d.detected?.kind, "email");
  assertEquals(d.seedValue, "jordan@example.com");
  assert(!leaks(d.title) && !leaks(d.seedValue));
});

Deno.test("upload-only at run time: the `(seed)` fallback is never a person, so no name echo is exempted", () => {
  // index.ts: seedValueRaw = splitSeedText(text).typed || "(seed)", and
  // subjectSeedName is set only when detectSeedServer(seedValueRaw) is a person.
  const runtimeSeed = splitSeedText(ONE).typed || "(seed)";
  assertEquals(runtimeSeed, "(seed)");
  assert(detectSeedServer(runtimeSeed)?.kind !== "person");
});

Deno.test("classify:false (thread already titled) classifies nothing", () => {
  assertEquals(deriveThreadSeed(`Jordan Example\n\n${ONE}`, { classify: false }).detected, null);
  assertEquals(deriveThreadSeed(ONE, { classify: false }).detected, null);
});

Deno.test("a compound name/address/age line is pinned at today's classification, not widened", () => {
  const typed = "Jordan Example, 100 Example St, Springfield, 45";
  const d = deriveThreadSeed(`${typed}\n\n${ONE}`, { classify: true });
  assertEquals(d.detected?.kind, detectSeedServer(typed)?.kind);
  assert(d.detected?.kind !== "person", "this PR does not teach the PERSON heuristic new shapes");
});

Deno.test("kill switch: every derivation is the old one, byte for byte", () => {
  withSwitch(() => {
    for (const text of [ONE, TWO, `Jordan Example\n\n${ONE}`, "Jordan Example"]) {
      const d = deriveThreadSeed(text, { classify: true });
      const old = detectSeedServer(text);
      assertEquals(d.detected, old);
      assertEquals(d.title, formatThreadTitle(text, old));
      assertEquals(d.seedValue, text.slice(0, 200));
      assertEquals(splitSeedText(text), { typed: text, attachments: [] });
      assertEquals(hasSeedAttachments(text), false);
    }
    assertEquals(attachmentSeedSelfTest().detail, "LEGACY via ATTACHMENT_SEED_STRIP_DISABLED");
  });
});

Deno.test("attachmentTitle never exceeds the thread title cap", () => {
  const long = `${"x".repeat(200)}.pdf`;
  assert(attachmentTitle([long]).length <= 80);
  assert(attachmentTitle([long, "b", "c"]).length <= 80);
  assert(attachmentTitle([long, "b", "c"]).endsWith(" +2"));
});

Deno.test("the /health self-test passes", () => {
  assertEquals(attachmentSeedSelfTest().ok, true, attachmentSeedSelfTest().detail);
});

Deno.test("attachment-intake still exports the same parser", () => {
  assertEquals(reExported, parseAttachments);
});

// ---- wiring: the three seed readers and /health all go through the splitter ----
const FN = new URL("../../functions/osint-agent/", import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, FN));

Deno.test("auth.ts stores the derived seed, not the raw first message", () => {
  const src = read("auth.ts");
  assert(src.includes("deriveThreadSeed("), "auth.ts must call deriveThreadSeed");
  assert(!src.includes("seed_value: text.slice(0, 200)"), "the raw-text seed write is gone");
  assert(src.includes('.eq("title", "New investigation")'), "the first-message guard still holds");
});

Deno.test("index.ts derives the run-time seed from the typed text at start and at completion", () => {
  const src = read("index.ts");
  assert((src.match(/splitSeedText\(/g) ?? []).length >= 2, "seedValueRaw and seedText both split");
  assert(/subjectSeedName[\s\S]{0,200}detectSeedServer\(seedValueRaw\)/.test(src), "echo exemption reads the stripped seed");
  assert(src.includes("hasSeedAttachments("), "attachment runs bypass the investigation_cache write");
});

Deno.test("/health registers checks.attachment_seed", () => {
  assert(read("health-handler.ts").includes("r.checks.attachment_seed = attachmentSeedSelfTest()"));
});
