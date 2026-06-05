/**
 * seed.ts — Thin convenience re-exports from validation.ts.
 * Extracted from index.ts (lines 284–341).
 *
 * This module exists so consumers that previously imported seed detection
 * and cache TTLs from index.ts can switch to a single import path without
 * changing their code.
 */

export { detectSeedServer, TTL_24H_MS, TOOL_TTL_MS, NO_CACHE_TOOLS } from "./validation.ts";
export type { DetectedSeed } from "./validation.ts";