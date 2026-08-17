// tools/geoseer_core.ts
//
// PURE, runtime-agnostic half of the GeoSeer tool (no npm/Deno imports) so the
// geolocatability gate and payload normalization are unit-testable.

/** Scene words that mean "there is outdoor/place signal to work with". */
const GEO_SIGNAL = [
  "outdoor", "outdoors", "outside", "landscape", "scenery", "skyline", "horizon",
  "mountain", "mountains", "hill", "cliff", "valley", "canyon", "desert", "dunes",
  "beach", "coast", "coastline", "shore", "ocean", "sea", "lake", "river", "waterfall",
  "forest", "woods", "trees", "field", "farm", "meadow", "park", "trail", "hiking",
  "snow", "glacier", "ski", "island", "harbor", "harbour", "marina", "pier", "dock",
  "street", "road", "highway", "intersection", "sidewalk", "crosswalk", "alley",
  "city", "cityscape", "downtown", "town", "village", "neighborhood", "suburb",
  "building", "buildings", "architecture", "house exterior", "apartment block",
  "storefront", "shop front", "restaurant exterior", "hotel", "stadium", "arena",
  "bridge", "tower", "monument", "statue", "landmark", "castle", "church", "temple",
  "mosque", "cathedral", "plaza", "square", "market", "campus", "school building",
  "airport", "runway", "train station", "railway", "platform", "bus stop", "metro",
  "parking lot", "gas station", "billboard", "street sign", "road sign", "signage",
  "license plate", "number plate", "graffiti", "mural", "skyscraper", "port",
  "backyard", "front yard", "driveway", "garden", "balcony view", "rooftop", "view of",
  "aerial", "drone shot", "satellite", "map", "terrain", "vegetation", "palm trees",
];

/** Scene words that mean "no capture-location signal exists" — hard skip. */
const NO_GEO_SIGNAL = [
  "indoor", "indoors", "inside a room", "bedroom", "living room", "bathroom",
  "kitchen", "office desk", "studio", "plain wall", "blank wall", "white background",
  "solid background", "selfie", "close-up of a face", "closeup of a face", "headshot",
  "portrait of", "mugshot", "booking photo", "avatar", "profile picture", "logo",
  "icon", "screenshot", "screen capture", "chat log", "document scan", "scanned document",
  "pdf page", "id card", "driver's license photo", "passport photo", "meme",
  "text overlay", "product photo", "car interior", "mirror selfie", "webcam",
];

export interface GeolocatabilityVerdict {
  geolocatable: boolean;
  reason: string;
  matched?: string[];
}

/** Escape regex metacharacters so every term is matched literally. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Word-boundary matchers for the term lists.
 *
 * The first implementation used raw `text.includes(term)`, which matches inside
 * unrelated words. Executed against it, four cases were wrong in BOTH directions:
 *
 *   "Iconic landmark: the Eiffel Tower"   -> BLOCKED   ("icon" inside "Iconic")
 *   "An iconic mountain vista"            -> BLOCKED   ("icon" inside "iconic")
 *   "Leather seats and a dashboard"       -> passed    ("sea"  inside "seats")
 *   "Sparkling water glass on a table"    -> passed    ("park" inside "Sparkling")
 *
 * The false negatives are the damaging half: "iconic" is a highly likely word in
 * a landmark description, so the gate silently refused exactly the images with
 * the strongest capture-location signal. The false positives spend a paid credit
 * on a car interior and an indoor object — the two things this gate exists to stop.
 *
 * A bare `\b…\b` would fix those but lose ordinary inflections ("shore" no longer
 * matching "shoreline"), which is the same silent-refusal failure in a new place.
 * So a short, explicit suffix set is allowed. "ic" is deliberately NOT in it.
 */
const INFLECTION = "(?:s|es|ed|ing|line|lines|side|sides|scape|scapes|top|tops)?";
const compileTerms = (terms: string[]) =>
  terms.map((t) => new RegExp(`\\b${escapeRe(t)}${INFLECTION}\\b`, "i"));

const GEO_SIGNAL_RE = compileTerms(GEO_SIGNAL);
const NO_GEO_SIGNAL_RE = compileTerms(NO_GEO_SIGNAL);

/**
 * PURE pre-gate. Decides whether a described image is worth a paid GeoSeer call.
 * Blocking evidence (indoor/portrait/screenshot) always wins over geo signal —
 * "selfie in a bedroom with a window view of trees" is still not geolocatable.
 */
export function assessGeolocatability(scene: string | undefined | null): GeolocatabilityVerdict {
  const text = (scene ?? "").toLowerCase().trim();
  if (text.length < 8) {
    return {
      geolocatable: false,
      reason: "no scene description — run gemini_vision (mode='image') first and pass its `scene`/`attributes` text so the geolocatability gate can evaluate the photo.",
    };
  }
  const blocked = NO_GEO_SIGNAL.filter((_w, i) => NO_GEO_SIGNAL_RE[i].test(text));
  if (blocked.length > 0) {
    return {
      geolocatable: false,
      reason: `scene has no capture-location signal (${blocked.slice(0, 3).join(", ")}) — GeoSeer is for outdoor/landmark/street imagery, not portraits, interiors, screenshots or documents.`,
      matched: blocked.slice(0, 5),
    };
  }
  const signals = GEO_SIGNAL.filter((_w, i) => GEO_SIGNAL_RE[i].test(text));
  if (signals.length === 0) {
    return {
      geolocatable: false,
      reason: "scene description contains no outdoor/place features (terrain, street, skyline, signage, architecture, landmark). Skipping paid geolocation.",
    };
  }
  return { geolocatable: true, reason: `outdoor/place features present: ${signals.slice(0, 5).join(", ")}`, matched: signals.slice(0, 8) };
}

interface GeoseerLocation {
  latitude?: number;
  longitude?: number;
  address?: string;
  confidence?: number;
  reasoning?: string;
}

/** Trim provider payload so a multi-candidate reply can't bloat context. */
export function normalizeGeoseer(body: Record<string, unknown>): Record<string, unknown> {
  const raw = Array.isArray(body.locations) ? body.locations as GeoseerLocation[] : [];
  const locations = raw.slice(0, 3).map((l) => ({
    latitude: typeof l.latitude === "number" ? l.latitude : null,
    longitude: typeof l.longitude === "number" ? l.longitude : null,
    address: typeof l.address === "string" ? l.address.slice(0, 200) : null,
    // provider gives 0-1; expose a 0-100 score too so recording sites don't
    // mistake 0.95 for "95 confidence" or 0.6 for "confirmed".
    provider_confidence: typeof l.confidence === "number" ? l.confidence : null,
    provider_confidence_pct: typeof l.confidence === "number" ? Math.round(l.confidence * 100) : null,
    reasoning: typeof l.reasoning === "string" ? l.reasoning.slice(0, 600) : null,
  })).filter((l) => l.latitude !== null && l.longitude !== null);
  return {
    locations,
    processing_time: typeof body.processing_time === "string" ? body.processing_time : null,
    requests_remaining: typeof body.API_Requests_remaining === "number" ? body.API_Requests_remaining : null,
  };
}

