/**
 * Returns true when the user has opted into reduced motion via the OS
 * (`prefers-reduced-motion: reduce`). Safe to call on the server — returns
 * false there. Use to gate JS-driven smooth scroll / animation against the
 * accessibility preference: CSS reduced-motion rules don't reach `scrollIntoView`
 * or `scrollTo` `behavior: "smooth"`.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Convenience: smooth when motion is allowed, instant when reduced. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
