import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Lexicons } from "@atproto/lexicon";
import type { RepoRecord } from "./atproto";
import { distanceKm, thisWeek, type AuthorData } from "./data";
import { discover } from "./discover";
import { evaluate, placeKey } from "./generators";
import {
  authorSource,
  editEvent,
  editLayer,
  editPin,
  layerSource,
  makeEvent,
  makeGenerator,
  makeLayer,
  makePin,
  NSID,
  type EventRecord,
  type LayerRecord,
  type PinRecord,
} from "./records";

function loadLexicons(dir: string): unknown[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return loadLexicons(p);
    return name.endsWith(".json") ? [JSON.parse(readFileSync(p, "utf8"))] : [];
  });
}
const strongRef = {
  lexicon: 1,
  id: "com.atproto.repo.strongRef",
  defs: { main: { type: "object", required: ["uri", "cid"], properties: { uri: { type: "string", format: "at-uri" }, cid: { type: "string", format: "cid" } } } },
};
const lex = new Lexicons([...loadLexicons(join(__dirname, "../../lexicons")), strongRef] as never[]);
const CID = "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm";

// ---- a small world: three people mapping Barcelona ----
let n = 0;
const rec = <T>(did: string, coll: string, value: T): RepoRecord<T> => ({ uri: `at://${did}/${coll}/${++n}`, cid: CID, value });
function author(did: string, handle: string): AuthorData {
  return { identity: { did, handle, pds: "https://pds.example" }, layers: [], pins: [], events: [], generators: [], loadedAt: 0 };
}
const A = author("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "a.example");
const B = author("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", "b.example");
const C = author("did:plc:cccccccccccccccccccccccc", "c.example");
const RAZZ = { lat: 41.3975863, lng: 2.1912493 };
const APOLO = { lat: 41.374, lng: 2.1694 };
function layer(a: AuthorData, name: string) {
  const l = rec<LayerRecord>(a.identity.did, NSID.layer, makeLayer({ name }));
  a.layers.push(l);
  return l;
}
function pin(a: AuthorData, l: RepoRecord<LayerRecord>, at: { lat: number; lng: number }, name: string, osm?: string) {
  a.pins.push(rec<PinRecord>(a.identity.did, NSID.pin, makePin({ layer: { uri: l.uri, cid: l.cid }, ...at, name, osm })));
}
const aClubs = layer(A, "clubs");
const bClubs = layer(B, "dance");
const cMisc = layer(C, "misc");
const cOther = layer(C, "secret");
pin(A, aClubs, RAZZ, "Razzmatazz", "way/426162558");
pin(B, bClubs, { lat: RAZZ.lat + 0.0001, lng: RAZZ.lng }, "Razz", "way/426162558"); // same OSM element
pin(A, aClubs, APOLO, "Sala Apolo");
pin(C, cMisc, { lat: APOLO.lat + 0.00005, lng: APOLO.lng }, "Apolo"); // no OSM, same ~25 m cell
pin(C, cOther, RAZZ, "Razzmatazz", "way/426162558");
const world = Object.fromEntries([A, B, C].map((a) => [a.identity.did, a]));

describe("generators", () => {
  it("validate against the lexicon", () => {
    const g = makeGenerator({ name: "consensus clubs", sources: [authorSource(A.identity.did), layerSource({ uri: bClubs.uri, cid: CID })], rule: "consensus", minAuthors: 2 });
    lex.assertValidRecord(NSID.generator, { $type: NSID.generator, ...g });
  });

  it("union draws every place once", () => {
    const g = makeGenerator({ name: "u", sources: [authorSource(A.identity.did), authorSource(B.identity.did)], rule: "union" });
    const out = evaluate(g, world);
    expect(out.map((p) => p.name).sort()).toEqual(["Razzmatazz", "Sala Apolo"]);
    expect(out.find((p) => p.name === "Razzmatazz")!.authors).toHaveLength(2);
  });

  it("consensus keeps only places enough distinct people pinned", () => {
    const g = makeGenerator({ name: "c", sources: [A, B, C].map((a) => authorSource(a.identity.did)), rule: "consensus", minAuthors: 3 });
    const out = evaluate(g, world);
    expect(out.map((p) => p.name)).toEqual(["Razzmatazz"]); // A, B and C all pinned it
    expect(out[0].authors).toHaveLength(3);
  });

  it("matches places without OSM ids by nearby coordinates", () => {
    const g = makeGenerator({ name: "c", sources: [authorSource(A.identity.did), layerSource({ uri: cMisc.uri, cid: CID })], rule: "consensus", minAuthors: 2 });
    expect(evaluate(g, world).map((p) => p.name)).toContain("Sala Apolo");
  });

  it("a layer source includes only that layer, not the author's others", () => {
    const g = makeGenerator({ name: "l", sources: [layerSource({ uri: cMisc.uri, cid: CID })], rule: "union" });
    expect(evaluate(g, world).map((p) => p.name)).toEqual(["Apolo"]);
  });

  it("a whole-author source ignores pins that author put on someone else's layer", () => {
    const sneaky = author("did:plc:dddddddddddddddddddddddd", "d.example");
    pin(sneaky, aClubs, { lat: 41.4, lng: 2.15 }, "Spam");
    const g = makeGenerator({ name: "u", sources: [authorSource(sneaky.identity.did)], rule: "union" });
    expect(evaluate(g, { ...world, [sneaky.identity.did]: sneaky })).toEqual([]);
  });

  it("refuses an impossible consensus", () => {
    expect(() => makeGenerator({ name: "c", sources: [authorSource(A.identity.did)], rule: "consensus", minAuthors: 2 })).toThrow(/only have 1/);
  });

  it("place keys prefer OSM identity", () => {
    expect(placeKey(A.pins[0].value)).toBe("osm:way/426162558");
    expect(placeKey(A.pins[1].value)).toMatch(/^h3:/);
  });
});

describe("editing", () => {
  it("keeps createdAt and stays valid", () => {
    const l = editLayer({ ...aClubs.value, createdAt: "2020-01-01T00:00:00.000Z" }, { name: "late clubs", color: "#36e0c8" });
    expect(l).toMatchObject({ name: "late clubs", color: "#36e0c8", createdAt: "2020-01-01T00:00:00.000Z" });
    lex.assertValidRecord(NSID.layer, { $type: NSID.layer, ...l });
  });
  it("pins change note and layer, never location", () => {
    const p = editPin(A.pins[0].value, { note: "  ", layer: { uri: bClubs.uri, cid: CID } });
    expect(p.note).toBeUndefined();
    expect(p.layer.uri).toBe(bClubs.uri);
    expect(p.location).toEqual(A.pins[0].value.location);
    lex.assertValidRecord(NSID.pin, { $type: NSID.pin, ...p });
  });
  it("events keep their (possibly area-only) location", () => {
    const e = makeEvent({ name: "x", startsAt: "2026-10-31T23:00:00Z", ...RAZZ, precision: "area" });
    const edited = editEvent(e, { name: "y", endsAt: "2026-11-01T06:00:00Z" });
    expect(edited.locations).toEqual(e.locations);
    expect(JSON.stringify(edited)).not.toContain("latitude");
    lex.assertValidRecord(NSID.event, { $type: NSID.event, ...edited });
  });
});

describe("this week", () => {
  it("collects the next 7 days across authors, soonest first, with distance", () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    const ev = (a: AuthorData, name: string, startsAt: string, precision: "exact" | "area" = "exact") =>
      a.events.push(rec<EventRecord>(a.identity.did, NSID.event, makeEvent({ name, startsAt, ...RAZZ, precision })));
    const x = author("did:plc:xxxxxxxxxxxxxxxxxxxxxxxx", "x.example");
    const y = author("did:plc:yyyyyyyyyyyyyyyyyyyyyyyy", "y.example");
    ev(x, "saturday", "2026-10-10T22:00:00Z", "area");
    ev(y, "tonight", "2026-10-08T22:00:00Z");
    ev(y, "next month", "2026-11-20T22:00:00Z");
    ev(x, "last week", "2026-10-01T22:00:00Z");
    const week = thisWeek([x, y], APOLO, now);
    expect(week.map((w) => w.event.value.name)).toEqual(["tonight", "saturday"]);
    expect(week[0].km).toBeCloseTo(distanceKm(APOLO, RAZZ), 1);
    expect(week[1].area).toBe(true);
  });
});

describe("discover", () => {
  it("intersects relay lists with who you follow", async () => {
    const f = (async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      const json = (b: unknown) => new Response(JSON.stringify(b));
      if (u.pathname.endsWith("listReposByCollection")) {
        const c = u.searchParams.get("collection");
        if (c === NSID.layer) return json({ repos: [{ did: A.identity.did }, { did: C.identity.did }] });
        return json({ repos: [{ did: B.identity.did }] });
      }
      if (u.pathname.endsWith("getFollows"))
        return json({ follows: [A, B, author("did:plc:zzzzzzzzzzzzzzzzzzzzzzzz", "z.example")].map((a) => ({ did: a.identity.did, handle: a.identity.handle })) });
      if (u.pathname.endsWith("getProfiles")) return json({ profiles: u.searchParams.getAll("actors").map((d) => ({ did: d, handle: "c.example" })) });
      throw new Error(String(input));
    }) as typeof fetch;
    const d = await discover(f, "me.example");
    expect(d.followed.map((p) => [p.handle, p.hasLayers, p.hasEvents])).toEqual([
      ["a.example", true, false],
      ["b.example", false, true],
    ]);
    expect(d.others.map((p) => p.did)).toEqual([C.identity.did]);
    expect(d.totalMappers).toBe(2);
    expect(d.complete).toBe(true);
  });
});

it("OAuth scope covers every collection skymap writes", async () => {
  const { SKYMAP_SCOPE } = await import("./account");
  for (const c of [NSID.layer, NSID.pin, NSID.generator, NSID.event]) expect(SKYMAP_SCOPE.split(" ")).toContain(`repo:${c}`);
});
