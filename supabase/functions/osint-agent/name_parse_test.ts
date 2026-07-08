import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseStructuredName } from "./name-parse.ts";

Deno.test("parseStructuredName: LAST, FIRST MIDDLE → First Middle Last", () => {
  assertEquals(parseStructuredName("MORRIS, JARRETT RILEY"), {
    name: "JARRETT RILEY MORRIS",
  });
});

Deno.test("parseStructuredName: LAST, FIRST MIDDLE, ST → reorders + extracts state", () => {
  assertEquals(parseStructuredName("MORRIS, JARRETT RILEY, CA"), {
    name: "JARRETT RILEY MORRIS",
    state: "CA",
  });
});

Deno.test("parseStructuredName: LAST, FIRST ST (space-separated state)", () => {
  assertEquals(parseStructuredName("SMITH, JOHN TX"), {
    name: "JOHN SMITH",
    state: "TX",
  });
});

Deno.test("parseStructuredName: natural order passes through", () => {
  assertEquals(parseStructuredName("Jane Doe"), { name: "Jane Doe" });
  assertEquals(parseStructuredName("  Jarrett   Riley   Morris  "), { name: "Jarrett Riley Morris" });
});

Deno.test("parseStructuredName: ignores invalid two-letter suffix (not a state)", () => {
  assertEquals(parseStructuredName("DOE, JOHN XX"), { name: "JOHN XX DOE" });
});

Deno.test("parseStructuredName: empty input", () => {
  assertEquals(parseStructuredName(""), { name: "" });
  assertEquals(parseStructuredName("   "), { name: "" });
});
