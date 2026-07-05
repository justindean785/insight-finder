import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatThreadTitle, THREAD_TITLE_MAX, detectSeedServer } from "./validation.ts";

// issue #73 — human-readable thread titles, mirror of src/lib/seed.ts.

Deno.test("formatThreadTitle: labels an email seed", () => {
  assertEquals(formatThreadTitle("john.doe@gmail.com"), "Email: john.doe@gmail.com");
});

Deno.test("formatThreadTitle: labels a domain seed", () => {
  assertEquals(formatThreadTitle("example.com"), "Domain: example.com");
});

Deno.test("formatThreadTitle: labels a phone seed", () => {
  assertEquals(formatThreadTitle("8005551234"), "Phone: 8005551234");
});

Deno.test("formatThreadTitle: accepts a precomputed detection (no double-detect)", () => {
  const detected = detectSeedServer("admin@site.io");
  assertEquals(formatThreadTitle("admin@site.io", detected), "Email: admin@site.io");
});

Deno.test("formatThreadTitle: unclassified seed falls back to slice(0,80)", () => {
  const blob = "find everyone connected to the corner store on 4th and main street downtown";
  assertEquals(formatThreadTitle(blob), blob.slice(0, THREAD_TITLE_MAX));
});

Deno.test("formatThreadTitle: never exceeds the length cap", () => {
  const long = "a".repeat(200) + "@gmail.com";
  assertEquals(formatThreadTitle(long).length <= THREAD_TITLE_MAX, true);
});

Deno.test("formatThreadTitle: empty input returns empty string", () => {
  assertEquals(formatThreadTitle(""), "");
});
