import { useEffect, useState } from "react";

const WORKBENCH_QUERY = "(min-width: 1024px)";

/**
 * Tailwind's `lg` breakpoint, matched to the Workbench's `lg:block` gate in
 * ChatPage. Returns true when the Workbench is visible beside the content.
 *
 * Shared between ResourcesPanel (to suppress the modal drawer when the inline
 * Workbench already shows the detail) and ChatWindow (to switch the in-line
 * NextSteps for a compact "open workbench" summary — see register item 1).
 */
export function useIsWorkbenchViewport(): boolean {
  const [match, setMatch] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(WORKBENCH_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(WORKBENCH_QUERY);
    const onChange = () => setMatch(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return match;
}
