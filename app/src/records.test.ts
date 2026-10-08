import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Lexicons } from "@atproto/lexicon";
import { area, eventPlacement, makeEvent, makeLayer, makePin, NSID, placementOf, AREA_RESOLUTION, cellResolution } from "./records";

// Validate against the real lexicon JSON in ../../lexicons, not hand-copied shapes.
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

const layerRef = {
  uri: "at://did:plc:5y6kop75jnvkbujbubrhj6e3/org.jason-edelman.skymap.layer/3m2abcdefgh22",
  cid: "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm",
};
const RAZZ = { lat: 41.3975863, lng: 2.1912493 };

describe("layer", () => {
  it("validates and trims", () => {
    const l = makeLayer({ name: "  after hours  ", color: "#FF00AA" });
    expect(l.name).toBe("after hours");
    expect(l.color).toBe("#ff00aa");
    lex.assertValidRecord(NSID.layer, { $type: NSID.layer, ...l });
  });
  it("drops a malformed color instead of publishing it", () => {
    expect(makeLayer({ name: "x", color: "red" }).color).toBeUndefined();
  });
  it("refuses an empty name", () => {
    expect(() => makeLayer({ name: "   " })).toThrow();
  });
});

describe("pin", () => {
  it("validates against the pin lexicon with a geo location", () => {
    const p = makePin({ layer: layerRef, ...RAZZ, name: "Razzmatazz", osm: "way/426162558", note: "back room" });
    lex.assertValidRecord(NSID.pin, { $type: NSID.pin, ...p });
    expect(p.location).toMatchObject({ latitude: "41.397586", longitude: "2.191249" });
  });
  it("rejects impossible coordinates", () => {
    expect(() => makePin({ layer: layerRef, lat: 91, lng: 0 })).toThrow();
  });
});

describe("event (address drop)", () => {
  const base = { name: "warehouse", startsAt: "2026-10-31T23:00:00+01:00", ...RAZZ };

  it("exact precision publishes the coordinate", () => {
    const e = makeEvent({ ...base, precision: "exact" });
    lex.assertValidRecord(NSID.event, { $type: NSID.event, ...e });
    expect(eventPlacement(e)).toMatchObject({ kind: "point" });
  });

  it("area precision publishes only an H3 cell, never the coordinate", () => {
    const e = makeEvent({ ...base, precision: "area" });
    lex.assertValidRecord(NSID.event, { $type: NSID.event, ...e });
    const json = JSON.stringify(e);
    expect(json).not.toContain("41.3975");
    expect(json).not.toContain("2.1912");
    expect(json).not.toContain("latitude");
    const p = eventPlacement(e);
    expect(p?.kind).toBe("area");
    expect(cellResolution((e.locations![0] as unknown as { value: string }).value)).toBe(AREA_RESOLUTION);
  });

  it("area placement is the cell's centre, not the venue", () => {
    const p = placementOf(area(RAZZ.lat, RAZZ.lng));
    if (p?.kind !== "area") throw new Error("expected area");
    expect(p.lat).not.toBeCloseTo(RAZZ.lat, 6);
    expect(p.ring.length).toBeGreaterThanOrEqual(7); // closed hexagon
    expect(p.ring[0]).toEqual(p.ring[p.ring.length - 1]);
  });
});

describe("placementOf", () => {
  it("skips location kinds it can't draw", () => {
    expect(placementOf({ $type: "community.lexicon.location.address", country: "ES" })).toBeNull();
    expect(placementOf({ $type: NSID.hthree, value: "not-a-cell" })).toBeNull();
    expect(placementOf({ $type: NSID.geo, latitude: "abc", longitude: "2" })).toBeNull();
  });
});
