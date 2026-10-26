import { useEffect, useState } from "react";

/**
 * Tailwind's `xl` breakpoint, matched to the Workbench's `xl:block` gate in
 * ChatPage. Returns true when the Workbench is visible beside the content.
 *
 * Shared between ResourcesPanel (to suppress the modal drawer when the inline
 * Workbench already shows the detail) and ChatWindow (to switch the in-line
 * NextSteps for a compact "open workbench" summary — see register item 1).
 */
export function useIsWorkbenchViewport(): boolean {
  const [match, setMatch] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(min-width: 1280px)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(min-width: 1280px)");
    const onChange = () => setMatch(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return match;
}
