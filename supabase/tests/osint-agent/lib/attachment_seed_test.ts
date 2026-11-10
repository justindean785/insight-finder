// lib/attachment-seed.ts — the composer's "Attached files:" block (signed storage URLs)
// never becomes a case title or seed. Values are synthetic.
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@^1";
import {
  attachmentSeedSelfTest,
  attachmentSeedStripDisabled,
  attachmentTitle,
  deriveThreadSeed,
  splitAttachmentBlock,
} from "../../../functions/osint-agent/lib/attachment-seed.ts";
import { detectSeedServer, formatThreadTitle, THREAD_TITLE_MAX } from "../../../functions/osint-agent/validation.ts";

const URL_A = "https://storage.example.test/object/sign/uploads/case-export.pdf?token=AAA.BBB.CCC";
const URL_B = "https://storage.example.test/object/sign/uploads/photo.jpg?token=DDD.EEE.FFF";
const BLOCK_ONE = `Attached files:\n- [case-export.pdf](${URL_A}) (587.7 KB, application/pdf)`;
const BLOCK_TWO = `${BLOCK_ONE}\n- [photo.jpg](${URL_B}) (120 KB, image/jpeg)`;

const noLeak = (s: string) => !/token=|\/object\/sign\/|https?:\/\//i.test(s);

Deno.test("upload only: title names the file, seed is empty, no URL or token is stored", () => {
  const f = deriveThreadSeed(BLOCK_ONE, detectSeedServer, false);
  assertEquals(f.path, "attachment_only");
  assertEquals(f.title, "Attachment: case-export.pdf");
  assertEquals(f.seed_value, "");
  assert(noLeak(f.title) && noLeak(f.seed_value));
});

Deno.test("upload only: the seed TYPE is detected exactly as before, so the run's prompt does not change", () => {
  const f = deriveThreadSeed(BLOCK_ONE, detectSeedServer, false);
  assertEquals(f.detected, detectSeedServer(BLOCK_ONE));
});

Deno.test("several uploads: '+N more'", () => {
  assertEquals(deriveThreadSeed(BLOCK_TWO, detectSeedServer, false).title, "Attachment: case-export.pdf +1 more");
});

Deno.test("typed text above an upload is the seed (newline-separated and space-joined parts)", () => {
  for (const text of [`subject@example.com\n\n${BLOCK_ONE}`, `subject@example.com ${BLOCK_ONE}`]) {
    const f = deriveThreadSeed(text, detectSeedServer, false);
    assertEquals(f.path, "typed_with_attachment");
    assertEquals(f.seed_value, "subject@example.com");
    assertEquals(f.title, formatThreadTitle("subject@example.com", detectSeedServer("subject@example.com")));
    assertEquals(f.detected?.kind, "email");
    assert(noLeak(f.title) && noLeak(f.seed_value));
  }
});

Deno.test("no upload: byte-identical to the old derivation", () => {
  for (const text of ["subject@example.com", "example.com", "look into this account for me", "x".repeat(400)]) {
    const f = deriveThreadSeed(text, detectSeedServer, false);
    assertEquals(f.path, "no_attachment");
    assertEquals(f.title, formatThreadTitle(text, detectSeedServer(text)));
    assertEquals(f.seed_value, text.slice(0, 200));
    assertEquals(f.detected, detectSeedServer(text));
  }
});

Deno.test("the marker words with no parseable file line are left alone (not the composer's block)", () => {
  const text = "notes: Attached files: none yet";
  assertEquals(splitAttachmentBlock(text).attachments.length, 0);
  assertEquals(deriveThreadSeed(text, detectSeedServer, false).seed_value, text);
});

Deno.test("kill switch: the old derivation, byte for byte, even with an upload", () => {
  const f = deriveThreadSeed(BLOCK_ONE, detectSeedServer, true);
  assertEquals(f.path, "legacy");
  assertEquals(f.title, formatThreadTitle(BLOCK_ONE, detectSeedServer(BLOCK_ONE)));
  assertEquals(f.seed_value, BLOCK_ONE.slice(0, 200));
  assert(attachmentSeedStripDisabled((k) => (k === "ATTACHMENT_SEED_STRIP_DISABLED" ? "true" : undefined)));
  assertFalse(attachmentSeedStripDisabled(() => undefined));
});

Deno.test("an existing thread (detector off) still derives fields without detecting a seed", () => {
  const f = deriveThreadSeed(`subject@example.com\n\n${BLOCK_ONE}`, () => null, false);
  assertEquals(f.detected, null);
  assertEquals(f.seed_value, "subject@example.com");
});

Deno.test("a long file name keeps the title within the limit", () => {
  const long = `Attached files:\n- [${"n".repeat(200)}.pdf](${URL_A}) (1 KB)`;
  const t = attachmentTitle(splitAttachmentBlock(long).attachments);
  assert(t.length <= THREAD_TITLE_MAX, `${t.length}`);
  assert(t.startsWith("Attachment: "));
});

Deno.test("/health self-test passes and reports its switch", () => {
  const r = attachmentSeedSelfTest(detectSeedServer);
  assert(r.ok, r.detail);
  assertEquals(r.switch, "ATTACHMENT_SEED_STRIP_DISABLED");
});

Deno.test("wiring: auth.ts derives the seed through deriveThreadSeed and keeps the New-investigation guard", async () => {
  const src = await Deno.readTextFile(new URL("../../../functions/osint-agent/auth.ts", import.meta.url));
  assert(src.includes("deriveThreadSeed(text, isNewInvestigation ? detectSeedServer : () => null)"));
  assertFalse(src.includes("seed_value: text.slice(0, 200)"), "the raw message must not be written as the seed");
  assert(src.includes('.eq("title", "New investigation")'));
});

Deno.test("wiring: /health reports checks.attachment_seed", async () => {
  const src = await Deno.readTextFile(new URL("../../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(src.includes("r.checks.attachment_seed = attachmentSeedSelfTest(detectSeedServer)"));
});
