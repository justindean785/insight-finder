import { cn } from "@/lib/utils";

/**
 * One tab recipe for both strips: the case's main tabs (WorkspaceTabs) and the
 * right-hand workbench (Workbench). Same active surface, same brand underline,
 * same icon hue, so the two read as one control family; only the size differs
 * (the workbench is the secondary strip).
 */
const SIZE = {
  primary: "h-11 gap-2 px-0.5 text-[14px]",
  secondary: "h-9 gap-1.5 px-2.5 text-[13px] [@media(pointer:coarse)]:h-11",
} as const;

export function tabButtonClass(active: boolean, size: keyof typeof SIZE): string {
  return cn(
    "relative inline-flex shrink-0 items-center rounded-t-md font-medium",
    SIZE[size],
    "transition-[color,background-color,box-shadow] duration-fast ease-standard",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    // Case desk: no lifted ground on the active tab — a 2px lavender underline
    // and brighter ink carry it, as in JD's prototype.
    active
      ? "text-foreground shadow-[inset_0_-2px_0_hsl(var(--brand))]"
      : "text-subtle-foreground hover:text-foreground",
  );
}

export function tabIconClass(active: boolean): string {
  return cn("h-4 w-4 shrink-0", active ? "text-[hsl(var(--brand))]" : "opacity-75");
}
