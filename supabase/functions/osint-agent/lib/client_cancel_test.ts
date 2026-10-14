import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clientCancelIsolationCheck, persistOnClientCancelEnabled } from "./client-cancel.ts";

Deno.test("client cancel: only an explicit 'true' restores the legacy both-streams wiring", () => {
  for (const legacy of ["true", "TRUE", " true "]) assertEquals(persistOnClientCancelEnabled(legacy), true, legacy);
  for (const fixed of [undefined, null, "", "false", "1", "yes", "on", "truthy"]) {
    assertEquals(persistOnClientCancelEnabled(fixed), false, String(fixed));
  }
});

Deno.test("client cancel: /health reports the mode and is ok in both (the legacy mode is a choice, not a fault)", () => {
  const fixed = clientCancelIsolationCheck(undefined);
  assertEquals(fixed.ok, true);
  assertEquals(fixed.mode, "server_branch_only");
  const legacy = clientCancelIsolationCheck("true");
  assertEquals(legacy.ok, true);
  assertEquals(legacy.mode, "legacy_both_streams");
});
