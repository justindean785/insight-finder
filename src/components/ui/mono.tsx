import { cn } from "@/lib/utils";
import * as React from "react";

/**
 * Mono — display token for forensic data (timestamps, IDs, IPs, cost, hashes).
 * Geist Mono, 12px, tabular numerals, tight tracking.
 */
export const Mono = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "font-mono text-[12px] leading-none tabular-nums tracking-[-0.005em]",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  ),
);
Mono.displayName = "Mono";