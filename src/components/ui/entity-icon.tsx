import { cn } from "@/lib/utils";
import { ENTITY_ICONS, toEntityType, type EntityType } from "@/lib/entityIcons";

/**
 * EntityIcon — single glyph component for the 16-type entity vocabulary.
 * Accepts a curated EntityType or any artifact `kind` string.
 */
export function EntityIcon({
  type,
  kind,
  className,
  size = 16,
}: {
  type?: EntityType;
  kind?: string | null;
  className?: string;
  size?: number;
}) {
  const resolved = type ?? toEntityType(kind);
  const Icon = ENTITY_ICONS[resolved];
  return <Icon className={cn("text-muted-foreground", className)} style={{ width: size, height: size }} />;
}