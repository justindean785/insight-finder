/**
 * Relative-time formatting shared across thread/brain surfaces.
 *
 * NOTE: CustodyTab intentionally does NOT use this — chain-of-custody entries
 * need a precise absolute timestamp (date + time), so it keeps its own
 * `toLocaleString()` formatter. Don't collapse that one into this helper.
 */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
