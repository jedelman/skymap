// Record shapes skymap reads and writes, and the pure functions that build
// and interpret them. Everything public lands in someone's atproto repo, so
// the builders are the place to be careful about what gets published.

import { cellToBoundary, cellToLatLng, getResolution, isValidCell, latLngToCell } from "h3-js";

export const NSID = {
  layer: "org.jason-edelman.skymap.layer",
  pin: "org.jason-edelman.skymap.pin",
  event: "community.lexicon.calendar.event",
  geo: "community.lexicon.location.geo",
  hthree: "community.lexicon.location.hthree",
} as const;

/** H3 resolution for "area only" events: cells average roughly 0.7 km². */
export const AREA_RESOLUTION = 8;

/** Six decimals is ~0.1 m; nothing on a map of venues needs more. */
const COORD_DECIMALS = 6;

export interface StrongRef {
  uri: string;
  cid: string;
}

export interface GeoLocation {
  $type: typeof NSID.geo;
  latitude: string;
  longitude: string;
  name?: string;
}

export interface HthreeLocation {
  $type: typeof NSID.hthree;
  value: string;
  name?: string;
}

export interface LayerRecord {
  name: string;
  description?: string;
  color?: string;
  createdAt: string;
}

export interface PinRecord {
  layer: StrongRef;
  location: GeoLocation | HthreeLocation | { $type: string };
  osm?: string;
  note?: string;
  createdAt: string;
}

export interface EventRecord {
  name: string;
  description?: string;
  createdAt: string;
  startsAt?: string;
  endsAt?: string;
  mode?: string;
  status?: string;
  locations?: ({ $type: string } & Record<string, unknown>)[];
}

const now = () => new Date().toISOString();

export function geo(lat: number, lng: number, name?: string): GeoLocation {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error(`Invalid coordinate ${lat},${lng}`);
  }
  const out: GeoLocation = {
    $type: NSID.geo,
    latitude: lat.toFixed(COORD_DECIMALS),
    longitude: lng.toFixed(COORD_DECIMALS),
  };
  if (name) out.name = name;
  return out;
}

export function area(lat: number, lng: number, name?: string): HthreeLocation {
  const out: HthreeLocation = { $type: NSID.hthree, value: latLngToCell(lat, lng, AREA_RESOLUTION) };
  if (name) out.name = name;
  return out;
}

export function makeLayer(input: { name: string; description?: string; color?: string }): LayerRecord {
  const name = input.name.trim();
  if (!name) throw new Error("A layer needs a name");
  const out: LayerRecord = { name, createdAt: now() };
  if (input.description?.trim()) out.description = input.description.trim();
  if (input.color && /^#[0-9a-f]{6}$/i.test(input.color)) out.color = input.color.toLowerCase();
  return out;
}

export function makePin(input: {
  layer: StrongRef;
  lat: number;
  lng: number;
  name?: string;
  osm?: string;
  note?: string;
}): PinRecord {
  const out: PinRecord = { layer: input.layer, location: geo(input.lat, input.lng, input.name), createdAt: now() };
  if (input.osm) out.osm = input.osm;
  if (input.note?.trim()) out.note = input.note.trim();
  return out;
}

/**
 * The address drop. "exact" publishes the coordinate. "area" publishes only
 * the H3 cell the venue sits in, plus the place name only if the author
 * chooses to give one: the exact spot never leaves the device. Getting the
 * address to the people who should have it is atproto-iroh's job, not this
 * record's.
 */
export function makeEvent(input: {
  name: string;
  description?: string;
  startsAt: string;
  endsAt?: string;
  lat: number;
  lng: number;
  precision: "exact" | "area";
  placeName?: string;
}): EventRecord {
  const name = input.name.trim();
  if (!name) throw new Error("An event needs a name");
  const location =
    input.precision === "exact" ? geo(input.lat, input.lng, input.placeName) : area(input.lat, input.lng, input.placeName);
  const out: EventRecord = {
    name,
    createdAt: now(),
    startsAt: new Date(input.startsAt).toISOString(),
    mode: `${NSID.event}#inperson`,
    status: `${NSID.event}#scheduled`,
    locations: [location as unknown as { $type: string } & Record<string, unknown>],
  };
  if (input.endsAt) out.endsAt = new Date(input.endsAt).toISOString();
  if (input.description?.trim()) out.description = input.description.trim();
  return out;
}

export type Placement =
  | { kind: "point"; lat: number; lng: number }
  | { kind: "area"; cell: string; lat: number; lng: number; ring: [number, number][] };

/** Where to draw a location union value, or null if it's a kind we can't place (address, fsq). */
export function placementOf(loc: unknown): Placement | null {
  if (!loc || typeof loc !== "object") return null;
  const l = loc as Record<string, unknown>;
  if (l.$type === NSID.geo || (l.$type === undefined && "latitude" in l)) {
    const lat = Number(l.latitude);
    const lng = Number(l.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { kind: "point", lat, lng };
  }
  if (l.$type === NSID.hthree && typeof l.value === "string" && isValidCell(l.value)) {
    const [lat, lng] = cellToLatLng(l.value);
    // GeoJSON wants [lng, lat] and a closed ring.
    const ring = cellToBoundary(l.value, true) as [number, number][];
    return { kind: "area", cell: l.value, lat, lng, ring };
  }
  return null;
}

export function eventPlacement(e: EventRecord): Placement | null {
  for (const loc of e.locations ?? []) {
    const p = placementOf(loc);
    if (p) return p;
  }
  return null;
}

export function cellResolution(cell: string): number | null {
  return isValidCell(cell) ? getResolution(cell) : null;
}
