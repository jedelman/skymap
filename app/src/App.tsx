import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Feature, FeatureCollection } from "geojson";
import { createRecord, deleteRecord, login, type RepoRecord, type Session } from "./atproto";
import { MapView, type MapApi } from "./MapView";
import { layerColor, loadAuthor, upcoming, PALETTE, type AuthorData } from "./data";
import { eventPlacement, makeEvent, makeLayer, makePin, NSID, placementOf, type EventRecord, type LayerRecord, type PinRecord } from "./records";
import { reverseGeocode, searchPlaces, type Place } from "./search";
import { load, save } from "./storage";
import { locate } from "./locate";

type Sheet =
  | { kind: "place"; place: Place }
  | { kind: "pin"; uri: string }
  | { kind: "event"; uri: string }
  | { kind: "newEvent"; place: Place }
  | { kind: "layers" }
  | { kind: "me" };

const f: typeof fetch = (...a) => fetch(...a);
const EVENT_COLOR = "#ff4fa3";

export function App() {
  const [session, setSessionState] = useState<Session | null>(() => load("skymap.session", null));
  const [follows, setFollows] = useState<string[]>(() => load("skymap.follows", []));
  const [hidden, setHidden] = useState<string[]>(() => load("skymap.hidden", []));
  const [authors, setAuthors] = useState<Record<string, AuthorData>>({});
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mapApi = useRef<MapApi | null>(null);

  const setSession = (s: Session | null) => {
    save("skymap.session", s);
    setSessionState(s);
  };
  const say = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  }, []);

  const refreshAuthor = useCallback(
    async (handleOrDid: string) => {
      const data = await loadAuthor(f, handleOrDid);
      setAuthors((prev) => ({ ...prev, [data.identity.did]: data }));
      return data;
    },
    [],
  );

  // Read every repo this device follows, plus our own.
  const everyone = useMemo(() => [...new Set([...(session ? [session.did] : []), ...follows])], [session, follows]);
  useEffect(() => {
    for (const did of everyone) {
      if (authors[did]) continue;
      refreshAuthor(did).catch((e) => say(`Couldn't load ${did}: ${e.message}`));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyone]);

  const layersByUri = useMemo(() => {
    const out = new Map<string, { layer: RepoRecord<LayerRecord>; author: AuthorData }>();
    for (const a of Object.values(authors)) for (const l of a.layers) out.set(l.uri, { layer: l, author: a });
    return out;
  }, [authors]);

  const { pins, areas } = useMemo(() => {
    const pinFeatures: Feature[] = [];
    const areaFeatures: Feature[] = [];
    for (const a of Object.values(authors)) {
      for (const p of a.pins) {
        const owner = layersByUri.get(p.value.layer?.uri);
        if (!owner || hidden.includes(owner.layer.uri)) continue;
        const at = placementOf(p.value.location);
        if (at?.kind !== "point") continue;
        pinFeatures.push({
          type: "Feature",
          properties: { kind: "pin", uri: p.uri, color: layerColor(owner.layer), title: (p.value.location as { name?: string }).name ?? "" },
          geometry: { type: "Point", coordinates: [at.lng, at.lat] },
        });
      }
      if (hidden.includes(`events:${a.identity.did}`)) continue;
      for (const e of upcoming(a.events)) {
        const at = eventPlacement(e.value);
        if (!at) continue;
        const props = { kind: "event", uri: e.uri, color: EVENT_COLOR, title: e.value.name };
        if (at.kind === "area") {
          areaFeatures.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [at.ring] } });
        } else {
          pinFeatures.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [at.lng, at.lat] } });
        }
      }
    }
    const fc = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });
    return { pins: fc(pinFeatures), areas: fc(areaFeatures) };
  }, [authors, layersByUri, hidden]);

  function findRecord<T>(uri: string, pick: (a: AuthorData) => RepoRecord<T>[]) {
    for (const a of Object.values(authors)) {
      const r = pick(a).find((x) => x.uri === uri);
      if (r) return { record: r, author: a };
    }
    return null;
  }

  /** Runs a write as the signed-in user, keeps a refreshed session, and reloads their repo. */
  async function write(action: (s: Session) => Promise<Session>, done: string) {
    if (!session) return setSheet({ kind: "me" });
    setBusy(true);
    try {
      const next = await action(session);
      setSession(next);
      await refreshAuthor(next.did);
      say(done);
      return true;
    } catch (e) {
      say((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const myLayers = session ? authors[session.did]?.layers ?? [] : [];

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
        <button onClick={() => setSheet(sheet?.kind === "layers" ? null : { kind: "layers" })}>Layers</button>
        <button
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
        <button onClick={() => setSheet(sheet?.kind === "me" ? null : { kind: "me" })}>
          {session ? `@${session.handle.split(".")[0]}` : "Sign in"}
        </button>
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
                write(async (s) => {
                  const rec = makePin({ layer: { uri: layer.uri, cid: layer.cid }, ...sheet.place, note });
                  return (await createRecord(f, s, NSID.pin, { ...rec })).session;
                }, `Pinned to ${layer.value.name}`).then((ok) => ok && setSheet(null))
              }
              onNewLayer={() => setSheet({ kind: "layers" })}
            />
          )}

          {sheet.kind === "pin" &&
            (() => {
              const found = findRecord<PinRecord>(sheet.uri, (a) => a.pins);
              if (!found) return <p>Pin not found.</p>;
              const { record, author } = found;
              const layer = layersByUri.get(record.value.layer.uri)?.layer;
              const loc = record.value.location as { name?: string };
              return (
                <>
                  <h2>{loc.name || "Pin"}</h2>
                  <p className="meta">
                    on <b>{layer?.value.name ?? "unknown layer"}</b> by @{author.identity.handle ?? author.identity.did}
                  </p>
                  {record.value.note && <p className="note">{record.value.note}</p>}
                  {record.value.osm && (
                    <p className="meta">
                      <a href={`https://www.openstreetmap.org/${record.value.osm}`} target="_blank" rel="noreferrer">
                        OpenStreetMap: {record.value.osm}
                      </a>
                    </p>
                  )}
                  {session?.did === author.identity.did && (
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => write((s) => deleteRecord(f, s, record.uri), "Pin deleted").then((ok) => ok && setSheet(null))}
                    >
                      Delete pin
                    </button>
                  )}
                </>
              );
            })()}

          {sheet.kind === "event" &&
            (() => {
              const found = findRecord<EventRecord>(sheet.uri, (a) => a.events);
              if (!found) return <p>Event not found.</p>;
              const { record, author } = found;
              const at = eventPlacement(record.value);
              return (
                <>
                  <h2>{record.value.name}</h2>
                  <p className="meta">
                    {formatWhen(record.value.startsAt, record.value.endsAt)} · @{author.identity.handle ?? author.identity.did}
                  </p>
                  {record.value.description && <p className="note">{record.value.description}</p>}
                  {at?.kind === "area" ? (
                    <p className="drop">
                      Somewhere in this hexagon. The address goes to the list, not the map. (Tables over atproto-iroh will
                      carry it. That part isn't built yet.)
                    </p>
                  ) : (
                    <p className="meta">Exact location is public.</p>
                  )}
                  {session?.did === author.identity.did && (
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => write((s) => deleteRecord(f, s, record.uri), "Event deleted").then((ok) => ok && setSheet(null))}
                    >
                      Delete event
                    </button>
                  )}
                </>
              );
            })()}

          {sheet.kind === "newEvent" && (
            <EventForm
              place={sheet.place}
              busy={busy}
              onSubmit={(input) =>
                write(async (s) => (await createRecord(f, s, NSID.event, { ...makeEvent(input) })).session, "Event published").then(
                  (ok) => ok && setSheet(null),
                )
              }
            />
          )}

          {sheet.kind === "layers" && (
            <LayersSheet
              session={session}
              authors={authors}
              hidden={hidden}
              busy={busy}
              onToggle={(key) => {
                const next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
                save("skymap.hidden", next);
                setHidden(next);
              }}
              onCreate={(name, description, color) =>
                write(async (s) => (await createRecord(f, s, NSID.layer, { ...makeLayer({ name, description, color }) })).session, `Layer “${name}” created`)
              }
              onFollow={async (handle) => {
                setBusy(true);
                try {
                  const data = await refreshAuthor(handle);
                  if (!follows.includes(data.identity.did)) {
                    const next = [...follows, data.identity.did];
                    save("skymap.follows", next);
                    setFollows(next);
                  }
                  say(`Reading @${data.identity.handle ?? data.identity.did}: ${data.layers.length} layers, ${upcoming(data.events).length} upcoming events`);
                } catch (e) {
                  say((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
              onUnfollow={(did) => {
                const next = follows.filter((d) => d !== did);
                save("skymap.follows", next);
                setFollows(next);
                setAuthors((prev) => {
                  const { [did]: _gone, ...rest } = prev;
                  return rest;
                });
              }}
              onRefresh={() => Promise.all(everyone.map((d) => refreshAuthor(d).catch(() => null))).then(() => say("Refreshed"))}
            />
          )}

          {sheet.kind === "me" && (
            <MeSheet
              session={session}
              busy={busy}
              onLogin={async (id, pw) => {
                setBusy(true);
                try {
                  const s = await login(f, id, pw);
                  setSession(s);
                  say(`Signed in as @${s.handle}`);
                  setSheet(null);
                } catch (e) {
                  say((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
              onLogout={() => setSession(null)}
            />
          )}
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function formatWhen(start?: string, end?: string) {
  if (!start) return "date unknown";
  const s = new Date(start);
  const day = s.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return end ? `${day}, ${time(s)}–${time(new Date(end))}` : `${day}, ${time(s)}`;
}

function SearchBar({ near, onPick, onError }: { near(): { lat: number; lng: number } | undefined; onPick(p: Place): void; onError(m: string): void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    try {
      setResults(await searchPlaces(f, q.trim(), near()));
    } catch (err) {
      onError((err as Error).message);
    }
  }
  return (
    <div className="search">
      <form onSubmit={submit}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search places" enterKeyHint="search" />
      </form>
      {results.length > 0 && (
        <ul className="results">
          {results.map((r, i) => (
            <li key={i}>
              <button
                onClick={() => {
                  setResults([]);
                  onPick(r);
                }}
              >
                <b>{r.name}</b>
                <span>{r.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlaceSheet(props: {
  place: Place;
  signedIn: boolean;
  layers: RepoRecord<LayerRecord>[];
  busy: boolean;
  onSignIn(): void;
  onPin(layer: RepoRecord<LayerRecord>, note: string): void;
  onEvent(): void;
  onNewLayer(): void;
}) {
  const { place, layers } = props;
  const [layerUri, setLayerUri] = useState(layers[0]?.uri ?? "");
  const [note, setNote] = useState("");
  const layer = layers.find((l) => l.uri === layerUri) ?? layers[0];
  return (
    <>
      <h2>{place.name}</h2>
      {place.label && <p className="meta">{place.label}</p>}
      {!props.signedIn ? (
        <button onClick={props.onSignIn}>Sign in to pin this or post an event</button>
      ) : layers.length === 0 ? (
        <>
          <button onClick={props.onNewLayer}>Make your first layer</button>
          <button onClick={props.onEvent}>Post an event here</button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (layer) props.onPin(layer, note);
          }}
        >
          <label>
            Layer
            <select value={layer?.uri} onChange={(e) => setLayerUri(e.target.value)}>
              {layers.map((l) => (
                <option key={l.uri} value={l.uri}>
                  {l.value.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Note
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} placeholder="Why it's on this layer" />
          </label>
          <div className="row">
            <button type="submit" disabled={props.busy}>
              Pin it
            </button>
            <button type="button" onClick={props.onEvent}>
              Event here
            </button>
          </div>
          <p className="hint">Pins are public, in your own atproto repo.</p>
        </form>
      )}
    </>
  );
}

function EventForm({ place, busy, onSubmit }: { place: Place; busy: boolean; onSubmit(input: Parameters<typeof makeEvent>[0]): void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [precision, setPrecision] = useState<"area" | "exact">("area");
  const [showPlaceName, setShowPlaceName] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          name,
          description,
          startsAt,
          endsAt: endsAt || undefined,
          lat: place.lat,
          lng: place.lng,
          precision,
          placeName: precision === "exact" || showPlaceName ? place.name : undefined,
        });
      }}
    >
      <h2>New event</h2>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      </label>
      <div className="row">
        <label>
          Starts
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
        </label>
        <label>
          Ends
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </label>
      </div>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={3000} />
      </label>
      <fieldset>
        <legend>Who sees where</legend>
        <label className="choice">
          <input type="radio" checked={precision === "area"} onChange={() => setPrecision("area")} />
          <span>
            <b>Area only</b> — the map shows a hexagon of about 0.7 km². The address stays on this phone.
          </span>
        </label>
        {precision === "area" && (
          <label className="choice sub">
            <input type="checkbox" checked={showPlaceName} onChange={(e) => setShowPlaceName(e.target.checked)} />
            <span>Also publish the place name “{place.name}”</span>
          </label>
        )}
        <label className="choice">
          <input type="radio" checked={precision === "exact"} onChange={() => setPrecision("exact")} />
          <span>
            <b>Exact</b> — anyone can see the spot: {place.name}
          </span>
        </label>
      </fieldset>
      <button type="submit" disabled={busy}>
        Publish
      </button>
      <p className="hint">Published as a community.lexicon.calendar.event, so other atproto event apps can read it.</p>
    </form>
  );
}

function LayersSheet(props: {
  session: Session | null;
  authors: Record<string, AuthorData>;
  hidden: string[];
  busy: boolean;
  onToggle(key: string): void;
  onCreate(name: string, description: string, color: string): Promise<unknown>;
  onFollow(handle: string): void;
  onUnfollow(did: string): void;
  onRefresh(): void;
}) {
  const [handle, setHandle] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(PALETTE[0]);
  const list = Object.values(props.authors).sort((a, b) =>
    a.identity.did === props.session?.did ? -1 : b.identity.did === props.session?.did ? 1 : 0,
  );
  return (
    <>
      <h2>Layers</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (handle.trim()) props.onFollow(handle);
          setHandle("");
        }}
      >
        <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="Read someone's map: @handle" autoCapitalize="none" />
        <button type="submit" disabled={props.busy}>
          Add
        </button>
      </form>

      {list.length === 0 && <p className="hint">No maps loaded yet. Add a handle, or sign in to make your own layers.</p>}
      {list.map((a) => {
        const mine = a.identity.did === props.session?.did;
        const evKey = `events:${a.identity.did}`;
        const nEvents = upcoming(a.events).length;
        return (
          <div className="author" key={a.identity.did}>
            <header>
              <b>{mine ? "You" : `@${a.identity.handle ?? a.identity.did}`}</b>
              {!mine && (
                <button className="link" onClick={() => props.onUnfollow(a.identity.did)}>
                  stop reading
                </button>
              )}
            </header>
            {a.layers.map((l) => (
              <label className="layer" key={l.uri}>
                <input type="checkbox" checked={!props.hidden.includes(l.uri)} onChange={() => props.onToggle(l.uri)} />
                <i style={{ background: layerColor(l) }} />
                <span>
                  {l.value.name}
                  <small> · {a.pins.filter((p) => p.value.layer?.uri === l.uri).length}</small>
                </span>
              </label>
            ))}
            <label className="layer">
              <input type="checkbox" checked={!props.hidden.includes(evKey)} onChange={() => props.onToggle(evKey)} />
              <i style={{ background: EVENT_COLOR, borderRadius: 2 }} />
              <span>
                Events<small> · {nEvents} upcoming</small>
              </span>
            </label>
          </div>
        );
      })}

      {props.session && (
        <form
          className="new-layer"
          onSubmit={async (e) => {
            e.preventDefault();
            await props.onCreate(name, description, color);
            setName("");
            setDescription("");
          }}
        >
          <h3>New layer</h3>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name: benches nobody moves you from" required maxLength={64} />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this layer sees (optional)" maxLength={300} />
          <div className="swatches">
            {PALETTE.map((c) => (
              <button type="button" key={c} aria-label={c} className={c === color ? "on" : ""} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
          <button type="submit" disabled={props.busy}>
            Create layer
          </button>
        </form>
      )}
      <button className="link" onClick={props.onRefresh}>
        Refresh all
      </button>
    </>
  );
}

function MeSheet({ session, busy, onLogin, onLogout }: { session: Session | null; busy: boolean; onLogin(id: string, pw: string): void; onLogout(): void }) {
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  if (session)
    return (
      <>
        <h2>@{session.handle}</h2>
        <p className="meta">Writing to {session.pds}</p>
        <button onClick={onLogout}>Sign out</button>
      </>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onLogin(id, pw);
      }}
    >
      <h2>Sign in</h2>
      <label>
        Handle
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="you.bsky.social" autoCapitalize="none" required />
      </label>
      <label>
        App password
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="xxxx-xxxx-xxxx-xxxx" required />
      </label>
      <button type="submit" disabled={busy}>
        Sign in
      </button>
      <p className="hint">
        Use an app password (Bluesky: Settings → Privacy and security → App passwords), never your main password. Prototype only:
        proper atproto OAuth replaces this.
      </p>
    </form>
  );
}
