import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { augmentDorkQuery, scoreDorkRelevance, applyDorkRelevance, isTemplateOrSampleUrl } from "./dork-relevance.ts";

Deno.test("isTemplateOrSampleUrl: real template/sample docs that slip past query negatives", () => {
  for (const u of [
    "https://msnlabs.com/img/resume-sample.pdf",
    "https://www.jobsandskills.wa.gov.au/sites/default/files/uploads/jswa-resume-examples_may_20.pdf",
    "https://careered.stanford.edu/sites/g/files/sbiybj22801/files/media/file/resume-and-cover-letter-examples.pdf",
    "https://www.sec.gov/jobs/sample-resume.pdf",
    "https://example.org/docs/report-template.pdf",
  ]) {
    assertEquals(isTemplateOrSampleUrl(u), true, u);
  }
});

Deno.test("isTemplateOrSampleUrl: never trips on the host (example.com) or real subject docs", () => {
  for (const u of [
    "https://example.com/joel-ibarra-deed.pdf",
    "https://www.sjgov.org/docs/uncashed-warrants/warrants/uncw.pdf",
    "https://planning.lacity.gov/odocument/d919f2fd/TT-74990.pdf",
    "https://www.rcoe.us/media/1f1jtbrl/2025-26-staff-directory-042026.pdf",
  ]) {
    assertEquals(isTemplateOrSampleUrl(u), false, u);
  }
});

Deno.test("isTemplateOrSampleUrl: malformed / empty input → false (never throws)", () => {
  assertEquals(isTemplateOrSampleUrl("not a url"), false);
  assertEquals(isTemplateOrSampleUrl(""), false);
});

Deno.test("#8: augmentDorkQuery appends negative keywords", () => {
  const q = augmentDorkQuery('"5204653368" filetype:pdf');
  for (const k of ["sample", "template", "example", "guide"]) {
    assertEquals(q.includes(`-"${k}"`), true);
  }
});

Deno.test("#8: augmentDorkQuery is idempotent", () => {
  const once = augmentDorkQuery('"x" filetype:pdf');
  const twice = augmentDorkQuery(once);
  assertEquals(once, twice);
});

Deno.test("#8: seed not in text → relevance 0 (false positive)", () => {
  const r = scoreDorkRelevance({ text: "generic resume template lorem ipsum", seed: "5204653368", subjectName: "Chris Nanos" });
  assertEquals(r.relevance, 0);
});

Deno.test("#8: .gov template without name → relevance 0", () => {
  const r = scoreDorkRelevance({
    text: "Daily court calendar 5204653368 page 3",
    seed: "5204653368",
    subjectName: "Chris Nanos",
    url: "https://www.sec.gov/jobs/sample-resume.pdf",
  });
  assertEquals(r.relevance, 0);
});

Deno.test("#8: seed + name + city → 1.0", () => {
  const r = scoreDorkRelevance({
    text: "Chris Nanos, Tucson AZ, phone 5204653368",
    seed: "5204653368",
    subjectName: "Chris Nanos",
    subjectCity: "Tucson",
  });
  assertEquals(r.relevance, 1.0);
});

Deno.test("#8: seed only → 0.2", () => {
  const r = scoreDorkRelevance({ text: "contact 5204653368 for details", seed: "5204653368", subjectName: "Chris Nanos" });
  assertEquals(r.relevance, 0.2);
});

Deno.test("#8: not-fetched text → 0.1", () => {
  const r = scoreDorkRelevance({ text: null, seed: "5204653368", subjectName: "Chris Nanos" });
  assertEquals(r.relevance, 0.1);
});

Deno.test("#8: applyDorkRelevance scales cap (60 × 0 = 0)", () => {
  const r = scoreDorkRelevance({ text: "no seed here", seed: "5204653368" });
  assertEquals(applyDorkRelevance(60, r), 0);
});
