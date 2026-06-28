import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { augmentDorkQuery, scoreDorkRelevance, applyDorkRelevance } from "./dork-relevance.ts";

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
