// tools/geoseer.ts
//
// GeoSeer (geoseeer.com) — AI photo/video GEOLOCATION. Given a direct media URL
// it returns candidate {latitude, longitude, address, confidence, reasoning}
// locations for WHERE THE MEDIA WAS CAPTURED.
//
// NARROW BY DESIGN — this is a PIVOT tool, not a scanner. It must only fire when
// the investigation has already surfaced an image whose CONTENT is realistically
// geolocatable: outdoor scenery, landmarks, streets, storefronts, signage,
// skylines, terrain, vehicles/plates in the open. A selfie in a bedroom, a
// headshot, an avatar, a screenshot, a logo, or a document scan has no
// geolocatable signal — calling GeoSeer on those burns a paid credit and returns
// noise, so `assessGeolocatability()` HARD-SKIPS them before any HTTP request.
//
// INTENDED FLOW:
//   scrape/OSINT surfaces an image  →  gemini_vision (mode='image') describes the
//   scene  →  if the scene is outdoor/geolocatable, pass that description here as
//   `scene` together with the direct image URL  →  GeoSeer returns coordinates.
//
// OUTCOME CONTRACT (drives cache.ts classifyToolOutcome):
//   • locations returned      → { ok:true, locations:[...] }        → ok
//   • key missing             → { error:"GEOSEER_API_KEY not configured" } → skipped
//   • scene not geolocatable  → { skipped:true, reason }            → skipped (free)
//   • non-2xx / success:false → { ok:false, status?, error }        → failed
//   • timeout / network       → { ok:false, error }                 → failed
//
// Classed `ai_summary` in source-classification.ts — a GeoSeer coordinate is a
// LEAD (capped ≤55), never a confirmed location on its own. Corroborate with
// EXIF, a post caption, a check-in, or a second image before treating it as fact.

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { assertSafeUrl } from "../safety.ts";
import { assessGeolocatability, normalizeGeoseer } from "./geoseer_core.ts";

export { assessGeolocatability, normalizeGeoseer } from "./geoseer_core.ts";
export type { GeolocatabilityVerdict } from "./geoseer_core.ts";

export const GEOSEER_ENDPOINT = "https://geoseeer.com/api/v1/analyze";
/** Observed: fast mode 7-45s. Wrapper cap in cache.ts sits ABOVE this. */
export const GEOSEER_HTTP_TIMEOUT_MS = 50_000;

const geoseerKey = (): string | undefined => Deno.env.get("GEOSEER_API_KEY");

export interface GeoseerArgs {
  image_url: string;
  scene: string;
  analysis_mode?: "fast" | "agent";
  subject_context?: string;
}

const getSignal = (opts: unknown): AbortSignal | undefined =>
  (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;

/** Shared runtime — exported so tests can drive it without the AI-SDK wrapper. */
export async function runGeoseer(
  args: GeoseerArgs,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const { image_url, scene, analysis_mode = "fast", subject_context } = args;
  const key = geoseerKey();
  if (!key) {
    return { error: "GEOSEER_API_KEY not configured", source: "geoseer_geolocate" };
  }

  // Pre-gate BEFORE any network/paid call — the whole point of the tool.
  const verdict = assessGeolocatability(scene);
  if (!verdict.geolocatable) {
    return {
      skipped: true,
      source: "geoseer_geolocate",
      url: image_url,
      reason: verdict.reason,
    };
  }

  let safe: URL;
  try {
    safe = assertSafeUrl(image_url);
  } catch (e) {
    return { ok: false, source: "geoseer_geolocate", error: `unsafe or invalid image url: ${e instanceof Error ? e.message : String(e)}` };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEOSEER_HTTP_TIMEOUT_MS);
  const onExt = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onExt, { once: true });
  }
  try {
    const res = await fetch(GEOSEER_ENDPOINT, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ url: safe.toString(), analysis_mode, stream: false }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = null; }

    if (!res.ok || !body) {
      const providerErr = body && typeof body.error === "object" && body.error
        ? String((body.error as { message?: unknown }).message ?? "")
        : (typeof body?.error === "string" ? body.error : "");
      // 402/429 = quota / rate limit → skip (not a provider failure we should
      // trip the circuit breaker on).
      if (res.status === 402 || res.status === 429) {
        return { skipped: true, source: "geoseer_geolocate", status: res.status, reason: providerErr || "GeoSeer quota or rate limit reached" };
      }
      return {
        ok: false,
        source: "geoseer_geolocate",
        status: res.status,
        url: image_url,
        error: `geoseer HTTP ${res.status}${providerErr ? `: ${providerErr}` : ""}`,
      };
    }

    if (body.success === false || body.status === "error") {
      const msg = typeof body.error === "object" && body.error
        ? String((body.error as { message?: unknown }).message ?? "geoseer error")
        : String(body.error ?? "geoseer error");
      // A non-downloadable link is the single most common failure: the provider
      // must fetch the media itself, so CDN/robots-blocked hosts always fail.
      return { ok: false, source: "geoseer_geolocate", url: image_url, error: msg.slice(0, 300) };
    }

    const norm = normalizeGeoseer(body);
    if ((norm.locations as unknown[]).length === 0) {
      return { ok: true, empty: true, source: "geoseer_geolocate", url: image_url, ...norm, note: "GeoSeer returned no candidate locations for this image." };
    }
    return {
      ok: true,
      source: "geoseer_geolocate",
      url: image_url,
      analysis_mode,
      subject_context: subject_context ?? null,
      gate: verdict.reason,
      ...norm,
      provenance: "inferred_from_image_geolocation",
      note: "LEAD-TIER: AI-inferred capture location. Corroborate with EXIF, caption, check-in, or a second image before treating as fact.",
    };
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    return {
      ok: false,
      source: "geoseer_geolocate",
      url: image_url,
      error: isAbort ? `geoseer timed out after ${GEOSEER_HTTP_TIMEOUT_MS}ms` : `geoseer error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExt);
  }
}

export const geoseer_geolocate = tool({
  description:
    "GEO-OSINT PIVOT — infer WHERE a photo/video was captured (lat/lon + address + reasoning) with GeoSeer's AI geolocation. " +
    "PREREQUISITE: run gemini_vision (mode='image') on the media FIRST and pass its scene/attributes text as `scene`. " +
    "ONLY call when the image genuinely contains capture-location signal — outdoor scenery (mountains, coast, forest, snow), streets, skylines, storefronts, signage, license plates, architecture, landmarks, stadiums, transport hubs. " +
    "NEVER call for indoor shots, selfies/portraits/headshots/mugshots, avatars, logos, screenshots, memes, or document scans — those are auto-skipped by the geolocatability gate and waste a paid credit. " +
    "Typical use: a scraped Instagram/X/Telegram profile yields a photo of the subject on a mountain trail or in front of a storefront → geolocate it to place the subject. " +
    "Requires a DIRECT media URL the provider can download (a page URL or a CDN that blocks crawlers will fail). Lead-tier (capped ≤55) — corroborate before treating a coordinate as fact. ~7-45s per call, paid credit.",
  inputSchema: z.object({
    image_url: z.string().describe("DIRECT image/video URL (ends in .jpg/.png/.webp/.mp4 or a direct CDN media link). Not a profile/page URL."),
    scene: z.string().describe("What the image actually shows, from gemini_vision's `scene`+`attributes` (e.g. 'man standing on a snowy mountain trail with pine forest and a wooden signpost'). Used by the geolocatability gate."),
    analysis_mode: z.enum(["fast", "agent"]).optional().default("fast").describe("'fast' (default, ~7-45s). 'agent' is deeper/slower — only for a high-value single image."),
    subject_context: z.string().optional().describe("Which subject/selector this image belongs to (handle, profile URL, name), for provenance."),
  }),
  execute: async (input: unknown, opts: unknown) => runGeoseer(input as GeoseerArgs, getSignal(opts)),
});

export default geoseer_geolocate;