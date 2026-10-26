import { useCallback, useEffect, useRef, useState, type FocusEvent } from "react";

/**
 * Focus state for the composer shell, with one rule: a blur caused by a click
 * elsewhere is applied only once that click has finished.
 *
 * Why: when the composer is idle and empty it collapses to one row the moment
 * it loses focus. That shrinks the shell, the transcript re-pins to the bottom,
 * and whatever sat under the pointer moves ~40px between `mousedown` (which
 * moves focus and fires the blur) and `mouseup`. The click then lands on the
 * wrong element. Measured 2026-10-26 on "Open Next pivots": focus reached the
 * button, the button moved from y=447 to y=487, `mouseup` hit the card above
 * it and the handler never ran. The textarea is focused on every thread load,
 * so this was the FIRST click on the page, every time.
 *
 * A keyboard blur (Tab, Escape) has no pointer in flight and collapses at once.
 * A pointer blur waits for `pointerup` and one more tick, so the `click` that
 * follows `mouseup` in the same task is dispatched before the layout changes.
 */
export function useComposerFocus(): {
  focused: boolean;
  onFocus: () => void;
  onBlur: (e: FocusEvent<HTMLElement>) => void;
} {
  const [focused, setFocused] = useState(false);
  const pointerDown = useRef(false);
  const releaseAfterPointer = useRef(false);

  useEffect(() => {
    const down = () => { pointerDown.current = true; };
    const up = () => {
      pointerDown.current = false;
      if (!releaseAfterPointer.current) return;
      releaseAfterPointer.current = false;
      // `click` is dispatched synchronously after `mouseup`, inside this same
      // task; a zero-delay timer runs after it, so the target is still where
      // the pointer went down.
      setTimeout(() => setFocused(false), 0);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
    };
  }, []);

  const onFocus = useCallback(() => {
    releaseAfterPointer.current = false;
    setFocused(true);
  }, []);

  // Tracked for the whole shell, not the textarea alone, so tabbing from the
  // box to Continue does not collapse the row under the keyboard.
  const onBlur = useCallback((e: FocusEvent<HTMLElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (pointerDown.current) {
      releaseAfterPointer.current = true;
      return;
    }
    setFocused(false);
  }, []);

  return { focused, onFocus, onBlur };
}
