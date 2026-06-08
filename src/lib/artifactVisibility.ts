/**
 * artifactVisibility.ts — pure split of artifacts into visible vs dismissed.
 *
 * Dismissing an artifact (review state "dismissed") should hide it from the
 * views while keeping it in the evidence chain/export (reversible). This is the
 * pure partition the list uses; the toggle in ResourcesPanel can reveal the
 * hidden ones to un-dismiss.
 */

export function partitionDismissed<T extends { id: string }>(
  items: T[],
  isDismissed: (id: string) => boolean,
): { visible: T[]; hidden: T[] } {
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const it of items) (isDismissed(it.id) ? hidden : visible).push(it);
  return { visible, hidden };
}
