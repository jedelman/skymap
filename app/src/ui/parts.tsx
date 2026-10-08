// The sheets and forms that open over the map. Stateless: App owns the data
// and passes callbacks; nothing here talks to the network except search.

import { useState, type FormEvent } from "react";
import type { RepoRecord } from "../atproto";
import type { OAuthSession as Session } from "../oauth";
import { layerColor, upcoming, PALETTE, type AuthorData } from "../data";
import { makeEvent, RULE, type GeneratorRecord, type LayerRecord } from "../records";
import { searchPlaces, type Place } from "../search";

const f: typeof fetch = (...a) => fetch(...a);
export const EVENT_COLOR = "#ff4fa3";

export function formatWhen(start?: string, end?: string) {
  if (!start) return "date unknown";
  const s = new Date(start);
  const day = s.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return end ? `${day}, ${time(s)}–${time(new Date(end))}` : `${day}, ${time(s)}`;
}

export function SearchBar({ near, onPick, onError }: { near(): { lat: number; lng: number } | undefined; onPick(p: Place): void; onError(m: string): void }) {
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

export function PlaceSheet(props: {
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

export function EventForm({ place, busy, onSubmit }: { place: Place; busy: boolean; onSubmit(input: Parameters<typeof makeEvent>[0]): void }) {
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

export function LayersSheet(props: {
  session: Session | null;
  authors: AuthorData[];
  hidden: string[];
  enabledGenerators: string[];
  busy: boolean;
  onToggle(key: string): void;
  onToggleGenerator(uri: string): void;
  onCreate(name: string, description: string, color: string): Promise<unknown>;
  onEditLayer(layer: RepoRecord<LayerRecord>, changes: { name: string; description: string; color: string }): Promise<unknown>;
  onDeleteLayer(layer: RepoRecord<LayerRecord>, pinCount: number): void;
  onNewGenerator(): void;
  onDeleteGenerator(uri: string): void;
  onFollow(handle: string): void;
  onUnfollow(did: string): void;
  onDiscover(): void;
  onRefresh(): void;
}) {
  const [handle, setHandle] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const list = [...props.authors].sort((a, b) =>
    a.identity.did === props.session?.did ? -1 : b.identity.did === props.session?.did ? 1 : 0,
  );
  const gens = list.flatMap((a) => a.generators.map((g) => ({ g, a })));
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
      <button className="link" onClick={props.onDiscover}>
        Find people who map →
      </button>

      {list.length === 0 && <p className="hint">No maps loaded yet. Add a handle, find people, or sign in to make your own layers.</p>}
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
            {a.layers.map((l) => {
              const count = a.pins.filter((p) => p.value.layer?.uri === l.uri).length;
              return editing === l.uri ? (
                <LayerEditor
                  key={l.uri}
                  layer={l}
                  busy={props.busy}
                  onCancel={() => setEditing(null)}
                  onSave={async (changes) => {
                    await props.onEditLayer(l, changes);
                    setEditing(null);
                  }}
                  onDelete={() => props.onDeleteLayer(l, count)}
                  pinCount={count}
                />
              ) : (
                <div className="layer-row" key={l.uri}>
                  <label className="layer">
                    <input type="checkbox" checked={!props.hidden.includes(l.uri)} onChange={() => props.onToggle(l.uri)} />
                    <i style={{ background: layerColor(l) }} />
                    <span>
                      {l.value.name}
                      <small> · {count}</small>
                      {l.value.description && <small className="desc">{l.value.description}</small>}
                    </span>
                  </label>
                  {mine && (
                    <button className="link" onClick={() => setEditing(l.uri)}>
                      edit
                    </button>
                  )}
                </div>
              );
            })}
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

      <div className="author">
        <header>
          <b>Generators</b>
          {props.session && (
            <button className="link" onClick={props.onNewGenerator}>
              + new
            </button>
          )}
        </header>
        {gens.length === 0 && <p className="hint">Recipes over other people's layers, run on this phone. None loaded yet.</p>}
        {gens.map(({ g, a }) => (
          <div className="layer-row" key={g.uri}>
            <label className="layer">
              <input type="checkbox" checked={props.enabledGenerators.includes(g.uri)} onChange={() => props.onToggleGenerator(g.uri)} />
              <i className="gen" style={{ borderColor: g.value.color ?? "#f5e663" }} />
              <span>
                {g.value.name}
                <small> · by @{a.identity.handle ?? a.identity.did} · {describeRule(g.value)}</small>
                {g.value.description && <small className="desc">{g.value.description}</small>}
              </span>
            </label>
            {a.identity.did === props.session?.did && (
              <button className="link" onClick={() => props.onDeleteGenerator(g.uri)}>
                delete
              </button>
            )}
          </div>
        ))}
      </div>

      {props.session && <NewLayerForm busy={props.busy} onCreate={props.onCreate} />}
      <button className="link" onClick={props.onRefresh}>
        Refresh all
      </button>
    </>
  );
}

export function describeRule(g: GeneratorRecord): string {
  const n = g.sources.length;
  const src = `${n} source${n === 1 ? "" : "s"}`;
  return g.rule === RULE.consensus ? `places ${g.minAuthors ?? 2}+ people pinned, from ${src}` : `everything in ${src}`;
}

function NewLayerForm({ busy, onCreate }: { busy: boolean; onCreate(name: string, description: string, color: string): Promise<unknown> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(PALETTE[0]);
  return (
    <form
      className="new-layer"
      onSubmit={async (e) => {
        e.preventDefault();
        await onCreate(name, description, color);
        setName("");
        setDescription("");
      }}
    >
      <h3>New layer</h3>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name: benches nobody moves you from" required maxLength={64} />
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this layer sees (optional)" maxLength={300} />
      <Swatches value={color} onChange={setColor} />
      <button type="submit" disabled={busy}>
        Create layer
      </button>
    </form>
  );
}

export function Swatches({ value, onChange }: { value: string; onChange(c: string): void }) {
  return (
    <div className="swatches">
      {PALETTE.map((c) => (
        <button type="button" key={c} aria-label={c} className={c === value ? "on" : ""} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

function LayerEditor(props: {
  layer: RepoRecord<LayerRecord>;
  busy: boolean;
  pinCount: number;
  onSave(changes: { name: string; description: string; color: string }): void;
  onCancel(): void;
  onDelete(): void;
}) {
  const [name, setName] = useState(props.layer.value.name);
  const [description, setDescription] = useState(props.layer.value.description ?? "");
  const [color, setColor] = useState(layerColor(props.layer));
  // A second tap instead of window.confirm(): Android WebViews may not show JS dialogs.
  const [confirming, setConfirming] = useState(false);
  return (
    <form
      className="editor"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave({ name, description, color });
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} aria-label="Layer name" />
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" maxLength={300} aria-label="Layer description" />
      <Swatches value={color} onChange={setColor} />
      <div className="row">
        <button type="submit" disabled={props.busy}>
          Save
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      <button
        type="button"
        className="danger"
        disabled={props.busy}
        onClick={() => (confirming || props.pinCount === 0 ? props.onDelete() : setConfirming(true))}
      >
        {confirming
          ? `Tap again: delete ${props.pinCount} pin${props.pinCount === 1 ? "" : "s"} for everyone reading`
          : `Delete layer${props.pinCount ? ` and its ${props.pinCount} pin${props.pinCount === 1 ? "" : "s"}` : ""}`}
      </button>
    </form>
  );
}

export function MeSheet({ session, busy, onLogin, onLogout }: { session: Session | null; busy: boolean; onLogin(handle: string): void; onLogout(): void }) {
  const [handle, setHandle] = useState("");
  if (session)
    return (
      <>
        <h2>@{session.handle}</h2>
        <p className="meta">Writing to {session.pds}</p>
        <p className="hint">
          skymap can write its own layers, pins and events to your account, and nothing else: no posts, follows or profile
          changes.
        </p>
        <button onClick={onLogout}>Sign out</button>
      </>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onLogin(handle);
      }}
    >
      <h2>Sign in</h2>
      <label>
        Your atproto handle
        <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="you.bsky.social" autoCapitalize="none" autoCorrect="off" required />
      </label>
      <button type="submit" disabled={busy}>
        Continue
      </button>
      <p className="hint">
        You'll approve skymap on your own server's sign-in page; skymap never sees your password. It asks to write only
        its own layers, pins and events.
      </p>
    </form>
  );
}
