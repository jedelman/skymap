// Evaluates a generator on this device, over whatever repos it has loaded.
// Same recipe, same inputs, same map: there's no server whose ranking you
// have to trust, and no averaging over people you didn't choose.

import { latLngToCell } from "h3-js";
import type { RepoRecord } from "./atproto";
import type { AuthorData } from "./data";
import { placementOf, RULE, type GeneratorRecord, type PinRecord } from "./records";

/** Resolution 11 cells are ~25 m across: two pins on the same venue land together. */
const SAME_PLACE_RESOLUTION = 11;

export interface GeneratedPlace {
  key: string;
  lat: number;
  lng: number;
  name: string;
  /** Distinct authors who pinned it. */
  authors: string[];
  pins: { pin: RepoRecord<PinRecord>; author: string }[];
}

/** Two pins are the same place if they name the same OSM element, else if they share a small H3 cell. */
export function placeKey(pin: PinRecord): string | null {
  if (pin.osm) return `osm:${pin.osm}`;
  const at = placementOf(pin.location);
  if (at?.kind !== "point") return null;
  return `h3:${latLngToCell(at.lat, at.lng, SAME_PLACE_RESOLUTION)}`;
}

export function sourceDids(g: GeneratorRecord): string[] {
  return [...new Set(g.sources.map((s) => ("did" in s ? s.did : s.layer.uri.split("/")[2])))];
}

export function evaluate(g: GeneratorRecord, authors: Record<string, AuthorData>): GeneratedPlace[] {
  const wantedLayers = new Set(g.sources.flatMap((s) => ("layer" in s ? [s.layer.uri] : [])));
  const wholeAuthors = new Set(g.sources.flatMap((s) => ("did" in s ? [s.did] : [])));
  const places = new Map<string, GeneratedPlace>();

  for (const a of Object.values(authors)) {
    const did = a.identity.did;
    const ownLayers = new Set(a.layers.map((l) => l.uri));
    for (const pin of a.pins) {
      const layer = pin.value.layer?.uri;
      // A whole-author source counts only pins on that author's own layers.
      const included = wantedLayers.has(layer) || (wholeAuthors.has(did) && ownLayers.has(layer));
      if (!included) continue;
      const key = placeKey(pin.value);
      const at = placementOf(pin.value.location);
      if (!key || at?.kind !== "point") continue;
      const place = places.get(key) ?? { key, lat: at.lat, lng: at.lng, name: "", authors: [], pins: [] };
      place.pins.push({ pin, author: did });
      if (!place.authors.includes(did)) place.authors.push(did);
      places.set(key, place);
    }
  }

  const min = g.rule === RULE.consensus ? g.minAuthors ?? 2 : 1;
  const out = [...places.values()].filter((p) => p.authors.length >= min);
  for (const p of out) p.name = mostCommonName(p) ?? "Unnamed place";
  return out.sort((a, b) => b.authors.length - a.authors.length || a.name.localeCompare(b.name));
}

function mostCommonName(p: GeneratedPlace): string | undefined {
  const counts = new Map<string, number>();
  for (const { pin } of p.pins) {
    const n = (pin.value.location as { name?: string }).name;
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
