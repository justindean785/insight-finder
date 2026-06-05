/**
 * tools/crypto.ts — Auto-extracted. Add imports manually.
 */
import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { createClient } from "npm:@supabase/supabase-js@2";

export const crypto_wallet = tool({
  description: "Inspect a Bitcoin or Ethereum address. Returns balance, tx count, and recent activity.",
  inputSchema: z.object({ chain: z.enum(["btc", "eth"]), address: z.string() }),
  execute: async ({ chain, address }) => {
    try {
      if (chain === "btc") {
        const r = await fetch(`https://blockstream.info/api/address/${encodeURIComponent(address)}`);
        const data = await r.json().catch(() => ({}));
        return { chain, address, data };
      }
      const r = await fetch(`https://api.blockchair.com/ethereum/dashboards/address/${encodeURIComponent(address)}?limit=10`);
      const data = await r.json().catch(() => ({}));
      return { chain, address, data };
    } catch (e) { return { error: String(e) }; }
  },
}),

