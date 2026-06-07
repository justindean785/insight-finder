/**
 * tools/serus.ts — AI SDK wrapper for the Serus darkweb scan agent.
 *
 * The scan orchestration lives in serus_core.ts so transport tests can import
 * it without loading npm:ai.
 */

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { SERUS_API_KEY } from "../env.ts";
import {
  isTerminalStatus,
  parseInitiateResponse,
  runSerusScan,
  serusErrorPayload,
  shapeTerminalResult,
} from "./serus_core.ts";

export {
  isTerminalStatus,
  parseInitiateResponse,
  runSerusScan,
  serusErrorPayload,
  shapeTerminalResult,
};

export const serus_darkweb_scan = tool({
  description:
    "Serus darkweb exposure scan. One tool, seven identifier types (email, phone, username, domain, keyword, origin, password). Initiates a scan and polls until completion (~5–30s). Returns breach count, breach names + data classes (masked by default; pass `reveal:true` to unmask passwords/tokens if your Serus key has the darkweb:reveal scope), paste count, and any extracted PII (emails, usernames, phones, names, crypto addresses) Serus surfaces. Cost: 0.25 credits per scan. Use as a SECONDARY or CORROBORATING breach source alongside breach_check / leakcheck_lookup / hibp_lookup / oathnet_lookup — Serus has its own corpus that often catches hits the others miss, especially on phone/username/password. Note: SERUS_API_KEY must be configured in the edge function secrets for this tool to be available.",
  inputSchema: z.object({
    identifierType: z.enum(["email", "phone", "username", "domain", "keyword", "origin", "password"])
      .describe("Serus identifier type. `origin` is an IP or hostname; `password` should only be used on a confirmed seed you own or are authorized to test."),
    identifierValue: z.string().min(1).describe("The value to scan. Email format: user@domain.tld. Phone: E.164 with country code preferred."),
    reveal: z.boolean().optional().default(false)
      .describe("Pass true to request unmasked breach fields (passwords, tokens). Requires the SERUS key to have the darkweb:reveal scope — otherwise Serus returns 403."),
  }),
  execute: async ({ identifierType, identifierValue, reveal }) => {
    if (!SERUS_API_KEY) {
      return { error: "SERUS_API_KEY not configured", code: "serus_key_missing", hint: "Set SERUS_API_KEY in the Supabase edge function secrets and redeploy." };
    }
    return runSerusScan(identifierType, identifierValue, { reveal });
  },
});
