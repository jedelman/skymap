// Sheets added for the full app: this week, discovery, generators, and the
// pin/event views that can now edit as well as show.

import { useEffect, useState } from "react";
import type { RepoRecord } from "../atproto";
import type { AuthorData, WeekItem } from "../data";
import type { Discovery, Person } from "../discover";
import type { GeneratedPlace } from "../generators";
import { eventPlacement, type EventRecord, type GeneratorRecord, type LayerRecord, type PinRecord } from "../records";
import { formatWhen, Swatches } from "./parts";

const at = (a: AuthorData) => `@${a.identity.handle ?? a.identity.did}`;

/** datetime-local wants local wall-clock time without a zone. */
function toLocalInput(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- this week ----------

/** The day is the heading, so items show only the time. */
function timeRange(start: string, end?: string): string {
  const t = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return end ? `${t(start)}–${t(end)}` : t(start);
}

export function WeekSheet({ items, nearOnly, onNearOnly, onOpen }: { items: WeekItem[]; nearOnly: boolean; onNearOnly(v: boolean): void; onOpen(item: WeekItem): void }) {
  const shown = nearOnly ? items.filter((i) => i.km !== undefined && i.km <= 25) : items;
  const byDay = new Map<string, WeekItem[]>();
  for (const i of shown) {
    const day = new Date(i.event.value.startsAt!).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    byDay.set(day, [...(byDay.get(day) ?? []), i]);
  }
  return (
    <>
      <h2>This week</h2>
      <label className="choice">
        <input type="checkbox" checked={nearOnly} onChange={(e) => onNearOnly(e.target.checked)} />
        <span>Only within 25 km of the map</span>
      </label>
      {shown.length === 0 && (
        <p className="hint">Nothing in the next seven days from the maps you read. Find people who post events under Layers → Find people.</p>
      )}
      {[...byDay.entries()].map(([day, list]) => (
        <div key={day} className="day">
          <h3>{day}</h3>
          {list.map((i) => (
            <button key={i.event.uri} className="item" onClick={() => onOpen(i)}>
              <b>{i.event.value.name}</b>
              <span>
                {timeRange(i.event.value.startsAt!, i.event.value.endsAt)} · {at(i.author)}
                {i.km !== undefined && ` · ${i.km < 1 ? "<1" : Math.round(i.km)} km`}
                {i.area && " · area only"}
              </span>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

// ---------- discovery ----------

export function DiscoverSheet(props: {
  load(actor: string | null): Promise<Discovery>;
  reading: string[];
  /** The signed-in account, or a handle typed here: follows are public either way. */
  actor: string | null;
  onActor(handle: string): void;
  onRead(p: Person): void;
}) {
  const [state, setState] = useState<{ d?: Discovery; error?: string }>({});
  const [handle, setHandle] = useState("");
  useEffect(() => {
    setState({});
    props.load(props.actor).then((d) => setState({ d }), (e) => setState({ error: (e as Error).message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.actor]);
  const row = (p: Person) => {
    const reading = props.reading.includes(p.did);
    return (
      <div className="person" key={p.did}>
        {p.avatar ? <img src={p.avatar} alt="" /> : <span className="avatar" />}
        <span className="who">
          <b>{p.displayName || p.handle}</b>
          <small>
            @{p.handle} · {[p.hasLayers && "layers", p.hasEvents && "events"].filter(Boolean).join(" + ")}
          </small>
        </span>
        <button disabled={reading} onClick={() => props.onRead(p)}>
          {reading ? "Reading" : "Read"}
        </button>
      </div>
    );
  };
  return (
    <>
      <h2>Find people who map</h2>
      {!state.d && !state.error && <p className="hint">Asking the relay who publishes layers and events…</p>}
      {state.error && <p className="hint">Couldn't reach the relay: {state.error}</p>}
      {state.d && (
        <>
          <h3>From who you follow on Bluesky</h3>
          {!props.actor && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (handle.trim()) props.onActor(handle.trim().replace(/^@/, ""));
              }}
            >
              <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="Your Bluesky handle" autoCapitalize="none" />
              <button type="submit">Look</button>
            </form>
          )}
          {props.actor && state.d.followed.length === 0 && <p className="hint">Nobody you follow publishes layers or events yet.</p>}
          {state.d.followed.map(row)}
          <h3>Everyone mapping on skymap ({state.d.totalMappers})</h3>
          {state.d.others.length === 0 && <p className="hint">No one else yet. You could be first.</p>}
          {state.d.others.map(row)}
          {!state.d.complete && <p className="hint">The relay has more than we asked for; this list is partial.</p>}
          <p className="hint">Found through the atproto relay. No skymap server knows who reads whom.</p>
        </>
      )}
    </>
  );
}

// ---------- generators ----------

export function GeneratorForm(props: {
  authors: AuthorData[];
  busy: boolean;
  onSubmit(input: { name: string; description: string; color: string; rule: "union" | "consensus"; minAuthors: number; dids: string[]; layers: RepoRecord<LayerRecord>[] }): void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#f5e663");
  const [rule, setRule] = useState<"union" | "consensus">("consensus");
  const [minAuthors, setMinAuthors] = useState(2);
  const [dids, setDids] = useState<string[]>([]);
  const [layers, setLayers] = useState<string[]>([]);
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const nAuthors = new Set([...dids, ...layers.map((u) => u.split("/")[2])]).size;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const ls = props.authors.flatMap((a) => a.layers).filter((l) => layers.includes(l.uri));
        props.onSubmit({ name, description, color, rule, minAuthors, dids, layers: ls });
      }}
    >
      <h2>New generator</h2>
      <p className="hint">A recipe anyone can subscribe to. Every phone that reads it works it out for itself.</p>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} placeholder="Where the dancers agree" />
      </label>
      <label>
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
      </label>
      <fieldset>
        <legend>Rule</legend>
        <label className="choice">
          <input type="radio" checked={rule === "consensus"} onChange={() => setRule("consensus")} />
          <span>
            <b>Overlap</b> — places at least{" "}
            <input className="num" type="number" min={1} max={50} value={minAuthors} onChange={(e) => setMinAuthors(Number(e.target.value))} /> of these people pinned
          </span>
        </label>
        <label className="choice">
          <input type="radio" checked={rule === "union"} onChange={() => setRule("union")} />
          <span>
            <b>Everything</b> — every place in any source
          </span>
        </label>
      </fieldset>
      <fieldset>
        <legend>Sources ({nAuthors} people)</legend>
        {props.authors.length === 0 && <p className="hint">Read some maps first; sources come from the people you read.</p>}
        {props.authors.map((a) => (
          <div key={a.identity.did} className="source">
            <label className="choice">
              <input type="checkbox" checked={dids.includes(a.identity.did)} onChange={() => toggle(dids, setDids, a.identity.did)} />
              <span>
                <b>{at(a)}</b> — all their layers
              </span>
            </label>
            {!dids.includes(a.identity.did) &&
              a.layers.map((l) => (
                <label className="choice sub" key={l.uri}>
                  <input type="checkbox" checked={layers.includes(l.uri)} onChange={() => toggle(layers, setLayers, l.uri)} />
                  <span>{l.value.name}</span>
                </label>
              ))}
          </div>
        ))}
      </fieldset>
      <Swatches value={color} onChange={setColor} />
      <button type="submit" disabled={props.busy || dids.length + layers.length === 0}>
        Publish generator
      </button>
    </form>
  );
}

export function GeneratedPlaceSheet({ place, generator, authors }: { place: GeneratedPlace; generator: RepoRecord<GeneratorRecord>; authors: Record<string, AuthorData> }) {
  const handle = (did: string) => authors[did]?.identity.handle ?? did;
  return (
    <>
      <h2>{place.name}</h2>
      <p className="meta">
        via <b>{generator.value.name}</b> · pinned by {place.authors.length} {place.authors.length === 1 ? "person" : "people"}
      </p>
      {place.pins.map(({ pin, author }) => {
        const layer = authors[author]?.layers.find((l) => l.uri === pin.value.layer.uri);
        return (
          <div key={pin.uri} className="voice">
            <small>
              @{handle(author)}
              {layer && ` · ${layer.value.name}`}
            </small>
            {pin.value.note ? <p className="note">{pin.value.note}</p> : <p className="hint">no note</p>}
          </div>
        );
      })}
    </>
  );
}

// ---------- pin + event views ----------

export function PinSheet(props: {
  pin: RepoRecord<PinRecord>;
  author: AuthorData;
  layerName?: string;
  mine: boolean;
  myLayers: RepoRecord<LayerRecord>[];
  busy: boolean;
  inGenerators: { uri: string; name: string; count: number }[];
  onOpenGenerated(uri: string): void;
  onSave(changes: { note: string; layer?: RepoRecord<LayerRecord> }): Promise<unknown>;
  onDelete(): void;
}) {
  const { pin } = props;
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(pin.value.note ?? "");
  const [layerUri, setLayerUri] = useState(pin.value.layer.uri);
  const name = (pin.value.location as { name?: string }).name || "Pin";
  if (editing)
    return (
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const layer = props.myLayers.find((l) => l.uri === layerUri);
          await props.onSave({ note, layer: layer && layer.uri !== pin.value.layer.uri ? layer : undefined });
          setEditing(false);
        }}
      >
        <h2>Edit {name}</h2>
        <label>
          Layer
          <select value={layerUri} onChange={(e) => setLayerUri(e.target.value)}>
            {props.myLayers.map((l) => (
              <option key={l.uri} value={l.uri}>
                {l.value.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Note
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={3} />
        </label>
        <div className="row">
          <button type="submit" disabled={props.busy}>
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </form>
    );
  return (
    <>
      <h2>{name}</h2>
      <p className="meta">
        on <b>{props.layerName ?? "unknown layer"}</b> by {at(props.author)}
      </p>
      {pin.value.note && <p className="note">{pin.value.note}</p>}
      {pin.value.osm && (
        <p className="meta">
          <a href={`https://www.openstreetmap.org/${pin.value.osm}`} target="_blank" rel="noreferrer">
            OpenStreetMap: {pin.value.osm}
          </a>
        </p>
      )}
      {props.inGenerators.map((g) => (
        <button key={g.uri} className="link" onClick={() => props.onOpenGenerated(g.uri)}>
          In “{g.name}”: {g.count} {g.count === 1 ? "person" : "people"} pinned this →
        </button>
      ))}
      {props.mine && (
        <div className="row">
          <button onClick={() => setEditing(true)}>Edit</button>
          <button className="danger" disabled={props.busy} onClick={props.onDelete}>
            Delete
          </button>
        </div>
      )}
    </>
  );
}

export function EventSheet(props: {
  event: RepoRecord<EventRecord>;
  author: AuthorData;
  mine: boolean;
  busy: boolean;
  onSave(changes: { name: string; description: string; startsAt: string; endsAt: string | null }): Promise<unknown>;
  onDelete(): void;
}) {
  const e = props.event.value;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(e.name);
  const [description, setDescription] = useState(e.description ?? "");
  const [startsAt, setStartsAt] = useState(toLocalInput(e.startsAt));
  const [endsAt, setEndsAt] = useState(toLocalInput(e.endsAt));
  const place = eventPlacement(e);
  if (editing)
    return (
      <form
        onSubmit={async (ev) => {
          ev.preventDefault();
          await props.onSave({ name, description, startsAt, endsAt: endsAt || null });
          setEditing(false);
        }}
      >
        <h2>Edit event</h2>
        <label>
          Name
          <input value={name} onChange={(x) => setName(x.target.value)} required maxLength={100} />
        </label>
        <div className="row">
          <label>
            Starts
            <input type="datetime-local" value={startsAt} onChange={(x) => setStartsAt(x.target.value)} required />
          </label>
          <label>
            Ends
            <input type="datetime-local" value={endsAt} onChange={(x) => setEndsAt(x.target.value)} />
          </label>
        </div>
        <label>
          Description
          <textarea value={description} onChange={(x) => setDescription(x.target.value)} rows={3} maxLength={3000} />
        </label>
        <p className="hint">Where it is stays as published. To change the place or its precision, post a new event.</p>
        <div className="row">
          <button type="submit" disabled={props.busy}>
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </form>
    );
  return (
    <>
      <h2>{e.name}</h2>
      <p className="meta">
        {formatWhen(e.startsAt, e.endsAt)} · {at(props.author)}
      </p>
      {e.description && <p className="note">{e.description}</p>}
      {place?.kind === "area" ? (
        <p className="drop">
          Somewhere in this hexagon. The address goes to the list, not the map. (Tables over atproto-iroh will carry it. That
          part isn't built yet.)
        </p>
      ) : place ? (
        <p className="meta">Exact location is public.</p>
      ) : (
        <p className="meta">No location skymap can draw.</p>
      )}
      {props.mine && (
        <div className="row">
          <button onClick={() => setEditing(true)}>Edit</button>
          <button className="danger" disabled={props.busy} onClick={props.onDelete}>
            Delete
          </button>
        </div>
      )}
    </>
  );
}
