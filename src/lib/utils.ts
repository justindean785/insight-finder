import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * TAILWIND-MERGE HAS TO BE TAUGHT THIS PROJECT'S TYPE SCALE.
 *
 * `text-*` is ambiguous: it sets a font size OR a text colour, and tailwind-merge
 * resolves the ambiguity by pattern. Tailwind's own sizes (`text-sm`, `text-2xl`)
 * are in its table; this project replaced that scale wholesale with named steps
 * (`eyebrow` … `display`, tailwind.config.ts), and a bare word it does not
 * recognise is filed as a COLOUR. So two classes it believed were both colours
 * would collide, and the later one won:
 *
 *     cn("text-eyebrow uppercase", "text-muted-foreground")
 *       -> "uppercase text-muted-foreground"        // the size is gone
 *     cn("text-muted-foreground", "text-eyebrow")
 *       -> "text-eyebrow"                           // the colour is gone
 *
 * Silent in both directions, and it only bites through `cn()` — the same two
 * classes written into one plain `className` string are untouched, which is why
 * it survived: every surface that looked right was written one way and every
 * surface that quietly rendered at the inherited 16px was written the other.
 * Measured 2026-09-22: 515 uses of a scale token across src/components and
 * src/pages.
 *
 * Naming the scale here fixes it in one place. Keep this list in step with
 * `fontSize` in tailwind.config.ts; `src/test/cn-type-scale.test.ts` fails if a
 * step is added there and forgotten here.
 */
export const TYPE_SCALE = [
  "eyebrow", "micro", "data", "meta", "body", "title", "h3", "h2", "h1", "display",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TYPE_SCALE] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
