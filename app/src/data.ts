// Loads everything skymap draws for one author: their layers, pins and events,
// straight from their own PDS. There is no skymap server in between; each
// device assembles its own map from the repos it chooses to read.

import { listRecords, resolveIdentity, type Fetch, type Identity, type RepoRecord } from "./atproto";
import { eventPlacement, NSID, type EventRecord, type GeneratorRecord, type LayerRecord, type PinRecord } from "./records";

export interface AuthorData {
  identity: Identity;
  layers: RepoRecord<LayerRecord>[];
  pins: RepoRecord<PinRecord>[];
  events: RepoRecord<EventRecord>[];
  generators: RepoRecord<GeneratorRecord>[];
  loadedAt: number;
}

export async function loadAuthor(f: Fetch, handleOrDid: string): Promise<AuthorData> {
  const identity = await resolveIdentity(f, handleOrDid);
  const [layers, pins, events, generators] = await Promise.all([
    listRecords<LayerRecord>(f, identity.pds, identity.did, NSID.layer),
    listRecords<PinRecord>(f, identity.pds, identity.did, NSID.pin),
    listRecords<EventRecord>(f, identity.pds, identity.did, NSID.event),
    listRecords<GeneratorRecord>(f, identity.pds, identity.did, NSID.generator),
  ]);
  return { identity, layers, pins, events, generators, loadedAt: Date.now() };
}

export const PALETTE = ["#ff4fa3", "#36e0c8", "#ffb341", "#8f7bff", "#7ddc5a", "#ff6b4a", "#4fb6ff", "#f5e663"];

export function layerColor(layer: RepoRecord<LayerRecord>): string {
  if (layer.value.color && /^#[0-9a-f]{6}$/i.test(layer.value.color)) return layer.value.color;
  let h = 0;
  for (const c of layer.uri) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Events from the next `days` days (and any running now), soonest first. */
export function upcoming(events: RepoRecord<EventRecord>[], nowMs = Date.now(), days = 60): RepoRecord<EventRecord>[] {
  const horizon = nowMs + days * 86_400_000;
  return events
    .filter((e) => {
      const start = Date.parse(e.value.startsAt ?? "");
      if (!Number.isFinite(start)) return false;
      const end = Date.parse(e.value.endsAt ?? "") || start + 12 * 3_600_000;
      return end >= nowMs && start <= horizon;
    })
    .sort((a, b) => Date.parse(a.value.startsAt!) - Date.parse(b.value.startsAt!));
}


export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface WeekItem {
  event: RepoRecord<EventRecord>;
  author: AuthorData;
  /** km from the map centre, when the event has a drawable location. */
  km?: number;
  area: boolean;
}

/** Everything starting in the next 7 days (or running now) across the given authors, soonest first. */
export function thisWeek(authors: AuthorData[], center?: { lat: number; lng: number }, nowMs = Date.now()): WeekItem[] {
  const items: WeekItem[] = [];
  for (const author of authors) {
    for (const event of upcoming(author.events, nowMs, 7)) {
      const at = eventPlacement(event.value);
      items.push({ event, author, km: at && center ? distanceKm(center, at) : undefined, area: at?.kind === "area" });
    }
  }
  return items.sort((a, b) => Date.parse(a.event.value.startsAt!) - Date.parse(b.event.value.startsAt!));
}
