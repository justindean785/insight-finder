import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A finished agent report can run to several thousand pixels (measured on a
 * live 70-artifact case, 2026-11-08: one closing report was 3,105px tall in a
 * transcript viewport of 184–265px). Read top-down, the summary sits first, so
 * the body opens clamped to `LONG_PROSE_CLAMP_PX` with a fade and one control
 * to read the rest. Nothing is removed: the full text stays in the DOM (find in
 * page, copy and screen readers still reach it) and `Copy` still copies all of it.
 *
 * Only measured overflow clamps — a short reply never grows a toggle — and a
 * message that is still streaming is never clamped (`disabled`), so a live run
 * never hides the line being written.
 */
export const LONG_PROSE_CLAMP_PX = 420;

export function LongProse({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) return;
    const measure = () => setOverflows(el.scrollHeight > LONG_PROSE_CLAMP_PX + 120);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [disabled]);

  const clamped = !disabled && overflows && !expanded;

  return (
    <div>
      <div
        id={bodyId}
        ref={ref}
        data-long-prose={clamped ? "clamped" : overflows ? "expanded" : undefined}
        className={cn(clamped && "overflow-hidden [mask-image:linear-gradient(to_bottom,black_78%,transparent)]")}
        style={clamped ? { maxHeight: LONG_PROSE_CLAMP_PX } : undefined}
      >
        {children}
      </div>
      {!disabled && overflows && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"
        >
          {expanded ? "Show less" : "Show the full message"}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} aria-hidden />
        </button>
      )}
    </div>
  );
}
