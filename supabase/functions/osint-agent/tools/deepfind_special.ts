/**
 * tools/deepfind_special.ts — Auto-extracted. Add imports manually.
 */
import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { createClient } from "npm:@supabase/supabase-js@2";

export const deepfind_ransomware_exposure = tool({
  description:
    "DeepFind.Me ransomware leak-site exposure check. Searches ransomware group leak sites for a domain, email, or identifier. High-signal for breach/extortion context.",
  inputSchema: z.object({ query: z.string().min(3) }),
  execute: async ({ query }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    try {
      const r = await fetch(`https://deepfind.me/api/ransomware-exposure`, {
        method: "POST",
        headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, source: "deepfind.ransomware", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const deepfind_vin_lookup = tool({
  description:
    "DeepFind.Me VIN decoder (17-char VIN → NHTSA vPIC vehicle specs + safety recalls).",
  inputSchema: z.object({ vin: z.string().length(17) }),
  execute: async ({ vin }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    try {
      const r = await fetch(`https://deepfind.me/api/vin-lookup`, {
        method: "POST",
        headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ vin }),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, source: "deepfind.vin", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const deepfind_aircraft_lookup = tool({
  description:
    "DeepFind.Me FAA N-Number lookup (US-registered aircraft → owner of record, airworthiness, engine).",
  inputSchema: z.object({ nNumber: z.string().min(2) }),
  execute: async ({ nNumber }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    try {
      const r = await fetch(`https://deepfind.me/api/us-aircraft-lookup`, {
        method: "POST",
        headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ nNumber }),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, source: "deepfind.aircraft", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const deepfind_vessel_lookup = tool({
  description:
    "DeepFind.Me vessel lookup (7-digit IMO or 9-digit MMSI → vessel identity, dimensions, build, ownership).",
  inputSchema: z.object({ identifier: z.string().min(7).max(9) }),
  execute: async ({ identifier }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    try {
      const r = await fetch(`https://deepfind.me/api/vessel-lookup`, {
        method: "POST",
        headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ identifier }),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, source: "deepfind.vessel", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

