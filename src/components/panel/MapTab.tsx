import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip, Popup, Polyline } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { MapPin, Radar, Crosshair } from "lucide-react";
import { EmptyState } from "./EmptyState";

type Pin = {
  id: string;
  lat: number;
  lon: number;
  kind: string;
  value: string;
  label: string;
  source?: string;
  confidence?: number;
};

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractCoords(meta: Record<string, unknown> | null | undefined): { lat: number; lon: number } | null {
  if (!meta) return null;
  const lat =
    asNum(meta.lat) ?? asNum(meta.latitude) ??
    asNum((meta.location as Record<string, unknown>)?.lat) ??
    asNum((meta.location as Record<string, unknown>)?.latitude) ??
    asNum((meta.geo as Record<string, unknown>)?.lat) ??
    asNum((meta.geo as Record<string, unknown>)?.latitude);
  const lon =
    asNum(meta.lon) ?? asNum(meta.lng) ?? asNum(meta.longitude) ??
    asNum((meta.location as Record<string, unknown>)?.lon) ??
    asNum((meta.location as Record<string, unknown>)?.lng) ??
    asNum((meta.location as Record<string, unknown>)?.longitude) ??
    asNum((meta.geo as Record<string, unknown>)?.lon) ??
    asNum((meta.geo as Record<string, unknown>)?.longitude);
  if (lat == null || lon == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function metaLabel(meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return "";
  const parts = [meta.city, meta.region, meta.state, meta.country]
    .filter((p) => typeof p === "string" && (p as string).trim().length > 0) as string[];
  return parts.join(", ");
}

// Lightweight in-memory + localStorage geocoder for address artifacts (Nominatim, free, no key).
// One request per address, 1.1s spacing to respect the Nominatim usage policy.
const GEOCODE_KEY = "proximity:geocode-v1";
function loadGeocodeCache(): Record<string, { lat: number; lon: number; display?: string } | null> {
  try { return JSON.parse(localStorage.getItem(GEOCODE_KEY) || "{}"); } catch { return {}; }
}
function saveGeocodeCache(c: Record<string, { lat: number; lon: number; display?: string } | null>) {
  try { localStorage.setItem(GEOCODE_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}

async function geocode(address: string): Promise<{ lat: number; lon: number; display?: string } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const j = (await res.json()) as Array<{ lat: string; lon: string; display_name?: string }>;
    if (!Array.isArray(j) || j.length === 0) return null;
    const lat = Number(j[0].lat);
    const lon = Number(j[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, display: j[0].display_name };
  } catch {
    return null;
  }
}

export function MapTab({ artifacts }: { artifacts: Artifact[] }) {
  const [geocoded, setGeocoded] = useState<Record<string, { lat: number; lon: number; display?: string } | null>>({});
  const containerRef = useRef<HTMLDivElement>(null);

  // Base pins from artifact metadata (IP geo, leaks with coords, etc.)
  const basePins = useMemo<Pin[]>(() => {
    const out: Pin[] = [];
    for (const a of artifacts) {
      const meta = (a.metadata ?? {}) as Record<string, unknown>;
      const c = extractCoords(meta);
      if (!c) continue;
      out.push({
        id: a.id,
        lat: c.lat,
        lon: c.lon,
        kind: a.kind,
        value: a.value,
        label: metaLabel(meta) || a.value,
        source: a.source ?? undefined,
        confidence: a.confidence ?? undefined,
      });
    }
    return out;
  }, [artifacts]);

  // Addresses that need geocoding
  const addressArtifacts = useMemo(
    () => artifacts.filter((a) => a.kind === "address" && typeof a.value === "string" && a.value.length > 4),
    [artifacts],
  );

  // Run geocoding sequentially with spacing
  useEffect(() => {
    let cancelled = false;
    const cache = loadGeocodeCache();
    setGeocoded(cache);
    const todo = addressArtifacts.filter((a) => !(a.value in cache));
    if (todo.length === 0) return;
    (async () => {
      for (const a of todo) {
        if (cancelled) return;
        const res = await geocode(a.value);
        cache[a.value] = res;
        saveGeocodeCache(cache);
        if (!cancelled) setGeocoded({ ...cache });
        await new Promise((r) => setTimeout(r, 1100));
      }
    })();
    return () => { cancelled = true; };
  }, [addressArtifacts]);

  const addressPins = useMemo<Pin[]>(() => {
    const out: Pin[] = [];
    for (const a of addressArtifacts) {
      const g = geocoded[a.value];
      if (!g) continue;
      out.push({
        id: a.id,
        lat: g.lat,
        lon: g.lon,
        kind: a.kind,
        value: a.value,
        label: g.display || a.value,
        source: a.source ?? undefined,
        confidence: a.confidence ?? undefined,
      });
    }
    return out;
  }, [addressArtifacts, geocoded]);

  const pins = useMemo(() => {
    // De-dupe coincident pins
    const seen = new Map<string, Pin>();
    for (const p of [...addressPins, ...basePins]) {
      const k = `${p.lat.toFixed(3)}:${p.lon.toFixed(3)}:${p.kind}`;
      if (!seen.has(k)) seen.set(k, p);
    }
    return Array.from(seen.values());
  }, [addressPins, basePins]);

  // Compute lines connecting all pins to the highest-confidence anchor for the "tactical" look
  const lines = useMemo(() => {
    if (pins.length < 2) return [] as [[number, number], [number, number]][];
    const anchor = [...pins].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
    return pins
      .filter((p) => p.id !== anchor.id)
      .map((p) => [[anchor.lat, anchor.lon], [p.lat, p.lon]] as [[number, number], [number, number]]);
  }, [pins]);

  const center: [number, number] = pins[0] ? [pins[0].lat, pins[0].lon] : [20, 0];
  const zoom = pins.length === 0 ? 2 : pins.length === 1 ? 5 : 3;

  // Fit to bounds after mount when multiple pins
  const mapRef = useRef<L.Map | null>(null);
  useEffect(() => {
    if (!mapRef.current || pins.length < 2) return;
    const b = L.latLngBounds(pins.map((p) => [p.lat, p.lon] as [number, number]));
    mapRef.current.fitBounds(b, { padding: [40, 40], maxZoom: 8 });
  }, [pins]);

  // Leaflet computes tile geometry off the container size at mount. When the
  // Map tab is mounted inside a previously-hidden tab panel (display:none
  // ancestor swapped in by Radix Tabs), the container reports a 0×0 size and
  // leaflet renders nothing — leaving only the dark `background` color, which
  // looks like a full-panel black overlay. invalidateSize() after layout
  // settles fixes it. We also re-run on tab show via a ResizeObserver.
  useEffect(() => {
    const m = mapRef.current;
    const el = containerRef.current;
    if (!m || !el) return;
    const kick = () => { try { m.invalidateSize(false); } catch { /* noop */ } };
    const t1 = window.setTimeout(kick, 0);
    const t2 = window.setTimeout(kick, 150);
    const t3 = window.setTimeout(kick, 600);
    const ro = new ResizeObserver(kick);
    ro.observe(el);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      ro.disconnect();
    };
  }, [pins.length]);

  if (pins.length === 0 && addressArtifacts.length === 0) {
    return (
      <EmptyState
        icon={MapPin}
        title="No geolocated artifacts yet"
        hint="IP geo lookups, address records, and breach coords will plot here."
      />
    );
  }

  const colorForKind = (k: string) => {
    if (k === "ip") return "hsl(170 90% 55%)";       // cyan
    if (k === "address") return "hsl(330 90% 60%)";  // magenta
    if (k === "breach") return "hsl(0 85% 60%)";     // red
    return "hsl(50 95% 60%)";                        // amber
  };

  return (
    <div className="p-3 space-y-3 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-eyebrow uppercase tracking-[0.18em] text-muted-foreground">
          <Radar className="w-3 h-3 text-primary" /> Geo-tactical Map
        </div>
        <span className="font-mono text-data text-muted-foreground">
          {pins.length} pin{pins.length === 1 ? "" : "s"}
          {addressArtifacts.length > pins.length && (
            <> · {addressArtifacts.length - addressPins.length} geocoding…</>
          )}
        </span>
      </div>

      <div
        ref={containerRef}
        className="relative rounded-lg overflow-hidden border border-primary/40"
        style={{
          height: 360,
          boxShadow: "0 0 0 1px hsl(var(--primary) / 0.15), 0 0 28px -6px hsl(var(--primary) / 0.45)",
        }}
      >
        <MapContainer
          center={center}
          zoom={zoom}
          scrollWheelZoom
          zoomControl={false}
          attributionControl={false}
          ref={(m) => { if (m) mapRef.current = m; }}
          style={{ height: "100%", width: "100%", background: "hsl(220 40% 4%)" }}
          className="cyber-map"
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png"
            subdomains="abcd"
          />
          {lines.map(([from, to], i) => (
            <Polyline
              key={i}
              positions={[from, to]}
              pathOptions={{
                color: "hsl(170 90% 55%)",
                weight: 1,
                opacity: 0.55,
                dashArray: "2 4",
              }}
            />
          ))}
          {pins.map((p) => {
            const c = colorForKind(p.kind);
            return (
              <CircleMarker
                key={p.id}
                center={[p.lat, p.lon]}
                radius={6}
                pathOptions={{
                  color: c,
                  weight: 1.5,
                  fillColor: c,
                  fillOpacity: 0.85,
                  className: "cyber-pin",
                }}
              >
                <Tooltip direction="top" offset={[0, -6]} opacity={1} className="cyber-tip">
                  <div className="font-mono text-data">
                    <div className="uppercase tracking-wider opacity-70">{p.kind}</div>
                    <div className="text-foreground">{p.label}</div>
                  </div>
                </Tooltip>
                <Popup className="cyber-popup">
                  <div className="font-mono text-data space-y-1">
                    <div className="flex items-center gap-1.5 text-eyebrow uppercase tracking-wider opacity-70">
                      <Crosshair className="w-3 h-3" /> {p.kind}
                      {p.confidence != null && <span className="ml-auto">{p.confidence}%</span>}
                    </div>
                    <div className="break-all">{p.value}</div>
                    {p.label && p.label !== p.value && (
                      <div className="opacity-70">{p.label}</div>
                    )}
                    <div className="opacity-50 text-[9px]">
                      {p.lat.toFixed(4)}, {p.lon.toFixed(4)}
                    </div>
                    {p.source && <div className="opacity-50 text-[9px]">via {p.source}</div>}
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>

        {/* Cyber grid + scanline overlay */}
        <div className="cyber-map-overlay pointer-events-none absolute inset-0" />
        <div className="pointer-events-none absolute top-2 left-2 font-mono text-[9px] text-primary/70 uppercase tracking-[0.2em]">
          ◉ Live
        </div>
        <div className="pointer-events-none absolute bottom-2 right-2 font-mono text-[8px] text-muted-foreground/70">
          © OpenStreetMap · CARTO
        </div>
      </div>

      <ul className="space-y-1">
        {pins.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-2 rounded-md border border-border-subtle bg-surface-1/60 px-2 py-1.5"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: colorForKind(p.kind), boxShadow: `0 0 8px ${colorForKind(p.kind)}` }}
              />
              <span className="text-eyebrow uppercase tracking-wider text-muted-foreground shrink-0">{p.kind}</span>
              <span className="font-mono truncate">{p.label}</span>
            </div>
            <span className="font-mono text-data text-muted-foreground shrink-0">
              {p.lat.toFixed(2)},{p.lon.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}