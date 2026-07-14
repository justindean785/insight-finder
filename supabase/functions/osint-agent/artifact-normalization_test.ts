// deno-lint-ignore no-import-prefix no-unversioned-import
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { normalizeArtifactValue } from "./artifact-normalization.ts";

Deno.test("phone normalization preserves country-code identity", () => {
  assertEquals(normalizeArtifactValue("phone", "+1 (916) 821-5143")?.normalizedValue, "+19168215143");
  assertEquals(normalizeArtifactValue("phone", "+7 (916) 821-51-43")?.normalizedValue, "+79168215143");
  assertEquals(normalizeArtifactValue("phone", "9168215143"), null);
});

Deno.test("email username and domain normalization is kind aware", () => {
  const rawEmail = " BigOakTree@GMAIL.COM ";
  assertEquals(normalizeArtifactValue("email", rawEmail), {
    displayValue: rawEmail,
    normalizedValue: "bigoaktree@gmail.com",
  });
  assertEquals(normalizeArtifactValue("username", " @BigOakTree ")?.normalizedValue, "bigoaktree");
  assertEquals(normalizeArtifactValue("domain", "BÜCHER.Example.")?.normalizedValue, "xn--bcher-kva.example");
});

Deno.test("email normalization preserves plus addressing", () => {
  const plusAddress = normalizeArtifactValue("email", "alice+case@example.com")?.normalizedValue;
  const plainAddress = normalizeArtifactValue("email", "alice@example.com")?.normalizedValue;
  assertEquals(plusAddress, "alice+case@example.com");
  assertNotEquals(plusAddress, plainAddress);
});

Deno.test("username normalization rejects multiple leading at signs", () => {
  assertEquals(normalizeArtifactValue("username", "@@name"), null);
});

Deno.test("IP normalization rejects hostnames and canonicalizes literals", () => {
  assertEquals(normalizeArtifactValue("ip", "example.com"), null);
  assertEquals(normalizeArtifactValue("ip", "192.168.1.10")?.normalizedValue, "192.168.1.10");
  assertEquals(
    normalizeArtifactValue("ip", "2001:0DB8:0000:0000:0000:FF00:0042:8329")?.normalizedValue,
    "2001:db8::ff00:42:8329",
  );
});

Deno.test("URL normalization preserves meaningful path and query", () => {
  assertEquals(
    normalizeArtifactValue("social_profile", "HTTPS://Example.COM:443/u/Alice?tab=posts")?.normalizedValue,
    "https://example.com/u/Alice?tab=posts",
  );
});
