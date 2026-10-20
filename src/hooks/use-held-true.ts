import { useEffect, useState } from "react";

/**
 * True once `value` has held true for `ms`, false the moment it drops.
 * For a state that is legitimately true for an instant during a normal
 * transition and should only show when it persists.
 */
export function useHeldTrue(value: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!value) { setHeld(false); return; }
    const id = window.setTimeout(() => setHeld(true), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return value && held;
}
