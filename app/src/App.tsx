import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Feature, FeatureCollection } from "geojson";
import type { RepoRecord } from "./atproto";
import { createRecord, deleteRecord, listenForSignIn, loadSession, putRecord, saveSession, signOut, startSignIn } from "./account";
import type { OAuthSession as Session } from "./oauth";
import { MapView, type MapApi } from "./MapView";
import { layerColor, loadAuthor, thisWeek, upcoming, type AuthorData } from "./data";
import { discover, type Discovery } from "./discover";
import { evaluate, sourceDids, type GeneratedPlace } from "./generators";
import {
  authorSource,
  editEvent,
  editLayer,
  editPin,
  eventPlacement,
  layerSource,
  makeEvent,
  makeGenerator,
  makeLayer,
  makePin,
  NSID,
  placementOf,
  type EventRecord,
  type GeneratorRecord,
  type LayerRecord,
  type PinRecord,
} from "./records";
import { reverseGeocode, type Place } from "./search";
import { load, save } from "./storage";
import { locate } from "./locate";
import { EVENT_COLOR, EventForm, LayersSheet, MeSheet, PlaceSheet, SearchBar } from "./ui/parts";
import { DiscoverSheet, EventSheet, GeneratedPlaceSheet, GeneratorForm, PinSheet, WeekSheet } from "./ui/sheets";

type Sheet =
  | { kind: "place"; place: Place }
  | { kind: "pin"; uri: string }
  | { kind: "event"; uri: string }
  | { kind: "gen"; uri: string }
  | { kind: "newEvent"; place: Place }
  | { kind: "newGenerator" }
  | { kind: "layers" }
  | { kind: "week" }
  | { kind: "discover" }
  | { kind: "me" };

const f: typeof fetch = (...a) => fetch(...a);
const GEN_COLOR = "#f5e663";

export function App() {
  const [session, setSessionState] = useState<Session | null>(() => loadSession());
  const [follows, setFollows] = useState<string[]>(() => load("skymap.follows", []));
  const [hidden, setHidden] = useState<string[]>(() => load("skymap.hidden", []));
  const [enabledGens, setEnabledGens] = useState<string[]>(() => load("skymap.generators", []));
  const [lookupHandle, setLookupHandle] = useState<string | null>(() => load("skymap.lookupHandle", null));
  const [nearOnly, setNearOnly] = useState<boolean>(() => load("skymap.weekNearOnly", false));
  // Every repo loaded on this device: the ones you read, plus generator sources.
  const [authors, setAuthors] = useState<Record<string, AuthorData>>({});
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mapApi = useRef<MapApi | null>(null);
  const discovery = useRef<{ actor: string | null; result: Promise<Discovery> } | null>(null);

  const setSession = useCallback((s: Session | null) => {
    saveSession(s);
    setSessionState(s);
  }, []);
  const say = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  }, []);
  const persist = <T,>(key: string, set: (v: T) => void) => (v: T) => {
    save(key, v);
    set(v);
  };

  const refreshAuthor = useCallback(async (handleOrDid: string) => {
    const data = await loadAuthor(f, handleOrDid);
    setAuthors((prev) => ({ ...prev, [data.identity.did]: data }));
    return data;
  }, []);

  // Who you read: yourself plus everyone you added.
  const everyone = useMemo(() => [...new Set([...(session ? [session.did] : []), ...follows])], [session, follows]);
  const reading = useMemo(() => everyone.map((d) => authors[d]).filter(Boolean), [everyone, authors]);

  // Enabled generators, wherever they were published, and the repos they need.
  const generators = useMemo(() => {
    const out: RepoRecord<GeneratorRecord>[] = [];
    for (const a of Object.values(authors)) for (const g of a.generators) if (enabledGens.includes(g.uri)) out.push(g);
    return out;
  }, [authors, enabledGens]);
  const needed = useMemo(() => [...new Set([...everyone, ...generators.flatMap((g) => sourceDids(g.value))])], [everyone, generators]);

  const loading = useRef(new Set<string>());
  useEffect(() => {
    for (const did of needed) {
      if (authors[did] || loading.current.has(did)) continue;
      loading.current.add(did);
      refreshAuthor(did)
        .catch((e) => say(`Couldn't load ${did}: ${e.message}`))
        .finally(() => loading.current.delete(did));
    }
  }, [needed, authors, refreshAuthor, say]);

  const layersByUri = useMemo(() => {
    const out = new Map<string, { layer: RepoRecord<LayerRecord>; author: AuthorData }>();
    for (const a of Object.values(authors)) for (const l of a.layers) out.set(l.uri, { layer: l, author: a });
    return out;
  }, [authors]);

  const generated = useMemo(() => {
    const out = new Map<string, { generator: RepoRecord<GeneratorRecord>; places: GeneratedPlace[] }>();
    for (const g of generators) out.set(g.uri, { generator: g, places: evaluate(g.value, authors) });
    return out;
  }, [generators, authors]);

  // Which generator places each pin feeds, so a pin can lead to the combined view.
  const pinInGenerators = useMemo(() => {
    const out = new Map<string, { uri: string; name: string; count: number }[]>();
    for (const { generator, places } of generated.values())
      for (const p of places)
        for (const { pin } of p.pins)
          out.set(pin.uri, [...(out.get(pin.uri) ?? []), { uri: `${generator.uri}|${p.key}`, name: generator.value.name, count: p.authors.length }]);
    return out;
  }, [generated]);

  const { pins, areas } = useMemo(() => {
    const pinFeatures: Feature[] = [];
    const areaFeatures: Feature[] = [];
    const point = (props: Record<string, unknown>, lat: number, lng: number): Feature => ({
      type: "Feature",
      properties: props,
      geometry: { type: "Point", coordinates: [lng, lat] },
    });
    for (const a of reading) {
      for (const p of a.pins) {
        const owner = layersByUri.get(p.value.layer?.uri);
        // Draw a pin only on its own author's layer: nobody can post onto your layer.
        if (!owner || owner.author.identity.did !== a.identity.did || hidden.includes(owner.layer.uri)) continue;
        const at = placementOf(p.value.location);
        if (at?.kind !== "point") continue;
        pinFeatures.push(point({ kind: "pin", uri: p.uri, color: layerColor(owner.layer), title: (p.value.location as { name?: string }).name ?? "" }, at.lat, at.lng));
      }
      if (hidden.includes(`events:${a.identity.did}`)) continue;
      for (const e of upcoming(a.events)) {
        const at = eventPlacement(e.value);
        if (!at) continue;
        const props = { kind: "event", uri: e.uri, color: EVENT_COLOR, title: e.value.name };
        if (at.kind === "area") areaFeatures.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [at.ring] } });
        else pinFeatures.push(point(props, at.lat, at.lng));
      }
    }
    for (const { generator, places } of generated.values()) {
      for (const p of places) {
        const title = p.authors.length > 1 ? `${p.name} ×${p.authors.length}` : p.name;
        pinFeatures.push(point({ kind: "gen", uri: `${generator.uri}|${p.key}`, color: generator.value.color ?? GEN_COLOR, title, count: p.authors.length }, p.lat, p.lng));
      }
    }
    const fc = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });
    return { pins: fc(pinFeatures), areas: fc(areaFeatures) };
  }, [reading, layersByUri, hidden, generated]);

  function findRecord<T>(uri: string, pick: (a: AuthorData) => RepoRecord<T>[]) {
    for (const a of Object.values(authors)) {
      const r = pick(a).find((x) => x.uri === uri);
      if (r) return { record: r, author: a };
    }
    return null;
  }

  // The OAuth redirect: a deep link in the app, this page's URL on the web.
  useEffect(() => {
    let stop: (() => void) | undefined;
    listenForSignIn(
      (s) => {
        setSession(s);
        say(`Signed in as @${s.handle}`);
        setSheet(null);
      },
      (e) => say(`Sign-in failed: ${e.message}`),
    ).then((unlisten) => (stop = unlisten));
    return () => stop?.();
  }, [setSession, say]);

  /** Runs writes as the signed-in user, keeps refreshed tokens, and reloads their repo. */
  async function write(action: (s: Session, keep: (s: Session) => void) => Promise<unknown>, done: string) {
    if (!session) {
      setSheet({ kind: "me" });
      return false;
    }
    setBusy(true);
    let latest = session;
    const keep = (s: Session) => {
      latest = s;
      setSession(s);
    };
    try {
      await action(session, keep);
      await refreshAuthor(latest.did);
      say(done);
      return true;
    } catch (e) {
      say((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function read(handleOrDid: string) {
    setBusy(true);
    try {
      const data = await refreshAuthor(handleOrDid);
      if (!follows.includes(data.identity.did)) persist("skymap.follows", setFollows)([...follows, data.identity.did]);
      say(`Reading @${data.identity.handle ?? data.identity.did}: ${data.layers.length} layers, ${upcoming(data.events).length} upcoming events`);
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const me = session ? authors[session.did] : undefined;
  const myLayers = me?.layers ?? [];
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const open = (kind: Sheet["kind"]) => setSheet(sheet?.kind === kind ? null : ({ kind } as Sheet));

  return (
    <div className="app">
      <MapView
        pins={pins}
        areas={areas}
        onReady={(api) => (mapApi.current = api)}
        onFeature={(kind, uri) => setSheet({ kind, uri })}
        onLongPress={async (lat, lng) => setSheet({ kind: "place", place: await reverseGeocode(f, lat, lng) })}
      />

      <SearchBar
        near={() => mapApi.current?.center()}
        onPick={(place) => {
          mapApi.current?.flyTo(place.lat, place.lng);
          setSheet({ kind: "place", place });
        }}
        onError={say}
      />

      <nav className="dock">
        <button onClick={() => open("week")}>Week</button>
        <button onClick={() => open("layers")}>Layers</button>
        <button
          aria-label="Show where I am"
          onClick={async () => {
            try {
              const at = await locate();
              mapApi.current?.showMe(at.lat, at.lng);
              mapApi.current?.flyTo(at.lat, at.lng, 15);
            } catch (e) {
              say((e as Error).message);
            }
          }}
        >
          Here
        </button>
        <button onClick={() => open("me")}>{session ? `@${session.handle.split(".")[0]}` : "Sign in"}</button>
      </nav>

      {sheet && (
        <section className="sheet" role="dialog">
          <button className="close" aria-label="Close" onClick={() => setSheet(null)}>
            ×
          </button>

          {sheet.kind === "place" && (
            <PlaceSheet
              place={sheet.place}
              signedIn={!!session}
              layers={myLayers}
              busy={busy}
              onSignIn={() => setSheet({ kind: "me" })}
              onEvent={() => setSheet({ kind: "newEvent", place: sheet.place })}
              onPin={(layer, note) =>
                write(
                  (s, keep) => createRecord(s, NSID.pin, { ...makePin({ layer: { uri: layer.uri, cid: layer.cid }, ...sheet.place, note }) }, keep),
                  `Pinned to ${layer.value.name}`,
                ).then((ok) => ok && setSheet(null))
              }
              onNewLayer={() => setSheet({ kind: "layers" })}
            />
          )}

          {sheet.kind === "pin" &&
            (() => {
              const found = findRecord<PinRecord>(sheet.uri, (a) => a.pins);
              if (!found) return <p>Pin not found.</p>;
              const { record, author } = found;
              return (
                <PinSheet
                  key={record.cid}
                  pin={record}
                  author={author}
                  layerName={layersByUri.get(record.value.layer.uri)?.layer.value.name}
                  mine={session?.did === author.identity.did}
                  myLayers={myLayers}
                  busy={busy}
                  inGenerators={pinInGenerators.get(record.uri) ?? []}
                  onOpenGenerated={(uri) => setSheet({ kind: "gen", uri })}
                  onSave={({ note, layer }) =>
                    write(
                      (s, keep) => putRecord(s, record.uri, record.cid, { ...editPin(record.value, { note, layer: layer && { uri: layer.uri, cid: layer.cid } }) }, keep),
                      "Pin saved",
                    )
                  }
                  onDelete={() => write((s, keep) => deleteRecord(s, record.uri, keep), "Pin deleted").then((ok) => ok && setSheet(null))}
                />
              );
            })()}

          {sheet.kind === "event" &&
            (() => {
              const found = findRecord<EventRecord>(sheet.uri, (a) => a.events);
              if (!found) return <p>Event not found.</p>;
              const { record, author } = found;
              return (
                <EventSheet
                  key={record.cid}
                  event={record}
                  author={author}
                  mine={session?.did === author.identity.did}
                  busy={busy}
                  onSave={(changes) => write((s, keep) => putRecord(s, record.uri, record.cid, { ...editEvent(record.value, changes) }, keep), "Event saved")}
                  onDelete={() => write((s, keep) => deleteRecord(s, record.uri, keep), "Event deleted").then((ok) => ok && setSheet(null))}
                />
              );
            })()}

          {sheet.kind === "gen" &&
            (() => {
              const [genUri, key] = sheet.uri.split("|");
              const g = generated.get(genUri);
              const place = g?.places.find((p) => p.key === key);
              if (!g || !place) return <p>That place is no longer in the generator.</p>;
              return <GeneratedPlaceSheet place={place} generator={g.generator} authors={authors} />;
            })()}

          {sheet.kind === "newEvent" && (
            <EventForm
              place={sheet.place}
              busy={busy}
              onSubmit={(input) =>
                write((s, keep) => createRecord(s, NSID.event, { ...makeEvent(input) }, keep), "Event published").then((ok) => ok && setSheet(null))
              }
            />
          )}

          {sheet.kind === "week" && (
            <WeekSheet
              items={thisWeek(reading, mapApi.current?.center())}
              nearOnly={nearOnly}
              onNearOnly={persist("skymap.weekNearOnly", setNearOnly)}
              onOpen={(item) => {
                const at = eventPlacement(item.event.value);
                if (at) mapApi.current?.flyTo(at.lat, at.lng, at.kind === "area" ? 14 : 16);
                setSheet({ kind: "event", uri: item.event.uri });
              }}
            />
          )}

          {sheet.kind === "discover" && (
            <DiscoverSheet
              actor={session?.did ?? lookupHandle}
              onActor={persist("skymap.lookupHandle", setLookupHandle)}
              reading={everyone}
              load={(actor) => {
                if (!discovery.current || discovery.current.actor !== actor) discovery.current = { actor, result: discover(f, actor) };
                return discovery.current.result;
              }}
              onRead={(p) => read(p.did)}
            />
          )}

          {sheet.kind === "newGenerator" && (
            <GeneratorForm
              authors={reading}
              busy={busy}
              onSubmit={(input) =>
                write(async (s, keep) => {
                  const g = makeGenerator({
                    name: input.name,
                    description: input.description,
                    color: input.color,
                    rule: input.rule,
                    minAuthors: input.minAuthors,
                    sources: [...input.dids.map(authorSource), ...input.layers.map((l) => layerSource({ uri: l.uri, cid: l.cid }))],
                  });
                  const ref = await createRecord(s, NSID.generator, { ...g }, keep);
                  persist("skymap.generators", setEnabledGens)([...enabledGens, ref.uri]);
                }, `Generator “${input.name}” published`).then((ok) => ok && setSheet({ kind: "layers" }))
              }
            />
          )}

          {sheet.kind === "layers" && (
            <LayersSheet
              session={session}
              authors={reading}
              hidden={hidden}
              enabledGenerators={enabledGens}
              busy={busy}
              onToggle={(key) => persist("skymap.hidden", setHidden)(toggle(hidden, key))}
              onToggleGenerator={(uri) => persist("skymap.generators", setEnabledGens)(toggle(enabledGens, uri))}
              onCreate={(name, description, color) =>
                write((s, keep) => createRecord(s, NSID.layer, { ...makeLayer({ name, description, color }) }, keep), `Layer “${name}” created`)
              }
              onEditLayer={(layer, changes) =>
                write((s, keep) => putRecord(s, layer.uri, layer.cid, { ...editLayer(layer.value, changes) }, keep), "Layer saved")
              }
              onDeleteLayer={(layer) => {
                write(async (s, keep) => {
                  let cur = s;
                  const k = (n: Session) => {
                    cur = n;
                    keep(n);
                  };
                  for (const p of me?.pins.filter((p) => p.value.layer.uri === layer.uri) ?? []) await deleteRecord(cur, p.uri, k);
                  await deleteRecord(cur, layer.uri, k);
                }, `Deleted “${layer.value.name}”`);
              }}
              onNewGenerator={() => setSheet({ kind: "newGenerator" })}
              onDeleteGenerator={(uri) =>
                write((s, keep) => deleteRecord(s, uri, keep), "Generator deleted").then(
                  (ok) => ok && persist("skymap.generators", setEnabledGens)(enabledGens.filter((u) => u !== uri)),
                )
              }
              onFollow={read}
              onUnfollow={(did) => persist("skymap.follows", setFollows)(follows.filter((d) => d !== did))}
              onDiscover={() => setSheet({ kind: "discover" })}
              onRefresh={() => Promise.all(needed.map((d) => refreshAuthor(d).catch(() => null))).then(() => say("Refreshed"))}
            />
          )}

          {sheet.kind === "me" && (
            <MeSheet
              session={session}
              busy={busy}
              onLogin={async (handle) => {
                setBusy(true);
                try {
                  await startSignIn(handle);
                } catch (e) {
                  say((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
              onLogout={() => {
                const s = session;
                setSession(null);
                if (s) signOut(s).catch(() => undefined);
              }}
            />
          )}
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
