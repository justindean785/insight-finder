/**
 * Source-independence check.
 *
 * Detects when multiple "sources" are actually downstream copies of the same
 * upstream dataset (e.g. a breach plus a Scribd mirror of that same breach, or
 * several aggregators all re-indexing one leak). Prevents false corroboration —
 * three mirrors of one leak are one source, not three.
 */

export type SourceType =
  | "breach"
  | "social"
  | "scribd"
  | "pastebin"
  | "github"
  | "news"
  | "registry"
  | "court"
  | "primary"
  | "unknown";

export interface Source {
  id: string;
  type: SourceType;
  origin?: string; // upstream dataset, e.g. "MyDriveSure-2019", "Zynga-2019"
  url?: string;
  retrievedAt: string; // ISO
  confidence: number; // 0–100
}

export interface IndependenceFinding {
  severity: "info" | "warn" | "error";
  message: string;
  sources: string[]; // source ids implicated
  effectiveCount: number; // count after collapsing duplicates
  declaredCount: number;
}

/**
 * Mirror / re-host domains. Content here cannot independently corroborate the
 * underlying leak — it IS the underlying leak, re-posted.
 */
const KNOWN_MIRRORS = new Set([
  "scribd.com",
  "pastebin.com",
  "ghostbin.com",
  "anonfiles.com",
  "raidforums.to",
  "breachforums.is",
  "doxbin.org",
  "leakix.net",
]);

/**
 * Secondary aggregators — they index breaches but rarely originate data. Two
 * aggregators agreeing usually means they ingested the same leak.
 */
const SECONDARY_AGGREGATORS = new Set([
  "leakcheck.io",
  "dehashed.com",
  "snusbase.com",
  "intelx.io",
  "haveibeenpwned.com",
]);

export function checkIndependence(sources: Source[]): IndependenceFinding[] {
  const findings: IndependenceFinding[] = [];

  // 1) Same origin = same dataset, regardless of how many mirrors carry it.
  const byOrigin = new Map<string, Source[]>();
  for (const s of sources) {
    if (!s.origin) continue;
    const key = s.origin.toLowerCase();
    byOrigin.set(key, [...(byOrigin.get(key) ?? []), s]);
  }
  for (const [origin, group] of byOrigin) {
    if (group.length > 1) {
      findings.push({
        severity: "warn",
        message:
          `Sources [${group.map((g) => g.id).join(", ")}] share origin "${origin}". ` +
          `Treat as ONE source, not ${group.length}.`,
        sources: group.map((g) => g.id),
        effectiveCount: 1,
        declaredCount: group.length,
      });
    }
  }

  // 2) Breach source(s) mixed with known mirror domain(s).
  const breachSources = sources.filter((s) => s.type === "breach");
  const mirrorSources = sources.filter((s) => isMirror(s.url) || s.type === "scribd" || s.type === "pastebin");
  if (breachSources.length > 0 && mirrorSources.length > 0) {
    findings.push({
      severity: "warn",
      message:
        "Mix of breach source(s) and known mirror domain(s). Verify the mirror " +
        "isn't a copy of the same dataset before claiming independent corroboration.",
      sources: [...breachSources, ...mirrorSources].map((s) => s.id),
      effectiveCount: 1,
      declaredCount: breachSources.length + mirrorSources.length,
    });
  }

  // 3) No primary source, ≥2 aggregators — likely all derive from one leak.
  const primary = sources.filter(
    (s) => s.type === "primary" || s.type === "court" || s.type === "registry",
  );
  const aggregators = sources.filter((s) => isAggregator(s.url));
  if (primary.length === 0 && aggregators.length >= 2) {
    findings.push({
      severity: "warn",
      message:
        `No primary source present. ${aggregators.length} aggregators may all ` +
        "derive from the same leaked dataset.",
      sources: aggregators.map((s) => s.id),
      effectiveCount: 1,
      declaredCount: aggregators.length,
    });
  }

  // 4) Headline: declared vs effectively-independent count.
  const effective = computeEffectiveSourceCount(sources);
  if (effective < sources.length) {
    findings.push({
      severity: "info",
      message: `Declared ${sources.length} sources → ${effective} effectively independent after collapsing mirrors/duplicates.`,
      sources: sources.map((s) => s.id),
      effectiveCount: effective,
      declaredCount: sources.length,
    });
  }

  return findings;
}

export function computeEffectiveSourceCount(sources: Source[]): number {
  const buckets = new Set<string>();
  for (const s of sources) {
    if (s.origin) {
      buckets.add(`origin:${s.origin.toLowerCase()}`);
    } else if (isMirror(s.url)) {
      // Anonymous re-host mirrors (scribd/pastebin/anonfiles) can't be told apart
      // without an origin — pool them so N mirrors of one dump don't read as N.
      buckets.add("mirror-pool");
    } else if (isAggregator(s.url)) {
      // Aggregators index MANY breaches — two DIFFERENT aggregators are not
      // automatically the same leak. Collapse only repeat hits from the SAME
      // aggregator host; keep distinct aggregators distinct.
      buckets.add(`aggregator:${hostOf(s.url)}`);
    } else {
      buckets.add(`id:${s.id}`);
    }
  }
  return buckets.size;
}

function hostOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isMirror(url?: string): boolean {
  const h = hostOf(url);
  return h != null && KNOWN_MIRRORS.has(h);
}

function isAggregator(url?: string): boolean {
  const h = hostOf(url);
  return h != null && SECONDARY_AGGREGATORS.has(h);
}
