/**
 * The board quick filter that holds an authority state, read off the board's own
 * filter groups (`STATUS_FILTER_GROUPS` in ResourcesPanel) rather than a second
 * mapping that could drift from them. The narrowest group wins ("review" over the
 * Analyst union); a state no group names falls back to "all".
 */
export function statusFilterForAuthority<K extends string>(
  state: string,
  groups: Record<K, Set<string> | null>,
  fallback: K,
): K {
  let best = fallback;
  let bestSize = Infinity;
  for (const [key, set] of Object.entries(groups) as [K, Set<string> | null][]) {
    if (set && set.has(state) && set.size < bestSize) {
      best = key;
      bestSize = set.size;
    }
  }
  return best;
}
