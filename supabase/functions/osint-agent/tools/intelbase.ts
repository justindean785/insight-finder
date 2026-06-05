/**
 * tools/intelbase.ts — IntelBase email lookup (breach + profile, gated/disabled).
 * Extracted from index.ts (lines 2141–2187).
 */

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { INTELBASE_ENABLED, INTELBASE_API_KEY } from "../env.ts";
import { gateStage2 } from "../guard.ts";

export const intelbase_email_lookup = tool({
  description:
    "IntelBase email lookup (https://api.intelbase.is/lookup/email). Aggregated breach + profile modules. Use as the PRIMARY email enrichment source — unlimited daily lookups on current plan. Run BEFORE oathnet_lookup. Note: breach_check (stolen.tax, 1000/day) is the main breach source and should already have fired via triage_seed.",
  inputSchema: z.object({
    email: z.string(),
    include_data_breaches: z.boolean().optional().default(true),
    timeout_ms: z.number().int().min(1000).max(60000).optional(),
    exclude_modules: z.array(z.string()).optional(),
  }),
  execute: async ({ email, include_data_breaches, timeout_ms, exclude_modules }) => {
    if (!INTELBASE_ENABLED) {
      console.warn("IntelBase skipped — gated due to instability");
      return {
        ok: false,
        skipped: true,
        gated: true,
        reason: "intelbase disabled (provider unhealthy ~33% success). Use breach_check / leakcheck_lookup / oathnet_lookup / bosint_email_lookup instead.",
      };
    }
    const gated = gateStage2("intelbase_email_lookup");
    if (gated) return gated;
    if (!INTELBASE_API_KEY) return { error: "INTELBASE_API_KEY not configured" };
    try {
      const body: Record<string, unknown> = { email, include_data_breaches };
      if (typeof timeout_ms === "number") body.timeout_ms = timeout_ms;
      if (exclude_modules && exclude_modules.length) body.exclude_modules = exclude_modules;
      const r = await fetch("https://api.intelbase.is/lookup/email", {
        method: "POST",
        headers: {
          "x-api-key": INTELBASE_API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 8000) }; }
      if (!r.ok) {
        console.warn(`[intelbase_email_lookup] HTTP ${r.status} snippet=${text.slice(0, 300)}`);
        return { error: `intelbase ${r.status}`, status: r.status, snippet: text.slice(0, 300), data };
      }
      return { ok: true, status: r.status, data };
    } catch (e) {
      return { error: String(e) };
    }
  },
});