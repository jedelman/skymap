// Place search and reverse geocoding over OpenStreetMap via Photon.
// The public komoot instance is fine for a prototype; it is not a service
// to build a public product on (no SLA, fair-use limits). Self-host later.

import type { Fetch } from "./atproto";

const PHOTON = "https://photon.komoot.io";

export interface Place {
  name: string;
  label: string;
  lat: number;
  lng: number;
  /** OSM element as type/id, e.g. way/426162558. */
  osm?: string;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | number | undefined>;
}

const OSM_TYPE: Record<string, string> = { N: "node", W: "way", R: "relation" };

export function placeFromPhoton(f: PhotonFeature): Place {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  const street = [p.street, p.housenumber].filter(Boolean).join(" ");
  const parts = [street, p.locality ?? p.district, p.city, p.country].filter(Boolean) as string[];
  const name = String(p.name ?? (street || p.city || "Dropped pin"));
  const osmType = OSM_TYPE[String(p.osm_type)];
  return {
    name,
    label: parts.filter((x) => x !== name).join(", "),
    lat,
    lng,
    osm: osmType && p.osm_id !== undefined ? `${osmType}/${p.osm_id}` : undefined,
  };
}

export async function searchPlaces(f: Fetch, q: string, near?: { lat: number; lng: number }): Promise<Place[]> {
  const url = new URL("/api/", PHOTON);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "8");
  if (near) {
    url.searchParams.set("lat", near.lat.toFixed(4));
    url.searchParams.set("lon", near.lng.toFixed(4));
  }
  const res = await f(url.toString());
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const json = (await res.json()) as { features: PhotonFeature[] };
  return json.features.map(placeFromPhoton);
}

export async function reverseGeocode(f: Fetch, lat: number, lng: number): Promise<Place> {
  const url = new URL("/reverse", PHOTON);
  url.searchParams.set("lat", lat.toFixed(6));
  url.searchParams.set("lon", lng.toFixed(6));
  try {
    const res = await f(url.toString());
    if (res.ok) {
      const json = (await res.json()) as { features: PhotonFeature[] };
      // Keep the pressed coordinate: reverse geocoding snaps to the nearest
      // feature, which may be across the street from where the finger was.
      const near = json.features[0] && placeFromPhoton(json.features[0]);
      if (near) return { name: "Dropped pin", label: `near ${[near.name, near.label].filter(Boolean).join(", ")}`, lat, lng };
    }
  } catch {
    // Offline or rate-limited: a bare coordinate is still a usable place.
  }
  return { name: "Dropped pin", label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng };
}
