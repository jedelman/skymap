# skymap

Maps on atproto. A Google Maps replacement at first; underneath, a biopolitical
urban commons.

The map itself (tiles, place data, search) is open infrastructure that already
exists. What Google actually holds is the layer on top: what people know and say
about places. skymap puts that layer in each person's own atproto repo, where
anyone can read it, re-cut it and publish their own reading of the city. No
global average, no canonical ranking: a proliferation of niches. Détournement in
public; the dérive, in private.

First users: the underground music scene, whose listings, tickets and flyers are
being enclosed by a few platforms, and whose own practice (the address drop: the
party is public, the location goes to the list) already has the public/private
split this design needs.

## What the prototype does (v0.0.1, Android first)

- **Map**: MapLibre over OpenFreeMap's OSM vector tiles, no key.
- **Search and long-press**: places from OpenStreetMap via Photon.
- **Sign in** with an atproto handle and an app password. Records are written
  straight to your own PDS; there is no skymap server.
- **Layers**: make a named layer, pin places to it with a note.
- **Read anyone's map**: add a handle; their layers and upcoming events load from
  their PDS and draw over yours. Toggle each layer.
- **Events with the address drop**: post a `community.lexicon.calendar.event`
  with either the exact spot, or **area only**: the record carries just the
  H3 cell (resolution 8, about 0.7 km²) and the map draws the hexagon. The exact
  coordinate never leaves the phone.

Not built yet: Tables over atproto-iroh (private check-ins and delivering the
address to the list), the did:iroh ↔ did:plc vault, map generators (published
rankings, on the feed-generator model), atproto OAuth, routing.

## Records

| Collection | What | Defined in |
|---|---|---|
| `org.jason-edelman.skymap.layer` | A named layer | `lexicons/org/jason-edelman/skymap/layer.json` |
| `org.jason-edelman.skymap.pin` | A place on a layer, with a note | `lexicons/org/jason-edelman/skymap/pin.json` |
| `community.lexicon.calendar.event` | Events (shared with Smoke Signal and other event apps) | Lexicon Community, vendored in `lexicons/community/` |

Locations use the Lexicon Community's `community.lexicon.location.*` types
(`geo`, `hthree`, `address`, `fsq`) rather than a skymap-specific shape.

## Layout

```
lexicons/          skymap's lexicons + vendored community ones (tests validate against these)
app/               the client: React + Vite + MapLibre
app/src-tauri/     Tauri 2 shell: packages the client for Android, adds geolocation
app/src-tauri/gen/android/   generated Gradle project (committed: the manifest carries location permissions)
```

## Develop

```bash
cd app
npm install
npm test            # unit tests, incl. lexicon validation of every record builder
npm run dev         # browser at http://localhost:1420
```

## Build the Android APK

Needs the Android SDK + NDK (`platforms;android-34`, `build-tools;34.0.0`,
`ndk;27.0.12077973`), the Rust Android targets, and `cargo install tauri-cli --version "^2"`.

```bash
cd app
export ANDROID_HOME=... NDK_HOME=$ANDROID_HOME/ndk/27.0.12077973
cargo tauri android build --target aarch64 --apk
```

The output is unsigned. Sign it (`zipalign` + `apksigner`) with a debug key to
side-load it, or a real release keystore to distribute it. If Gradle fails with
`429 Too Many Requests` from Maven Central, re-run: each attempt caches more.

## Known limits

- **Area-only is only as private as everything else you publish.** If the same
  account also pins the venue publicly, the hexagon points straight at it.
- **App passwords** are a prototype stand-in for atproto OAuth. The session is
  kept in the WebView's local storage.
- **Public Photon and OpenFreeMap** are fine for a prototype, not for a product
  (fair-use limits, no SLA). Self-host Photon; move tiles to Protomaps on R2.
- **Everything outside Tables is public**: pins, layers and events are readable by
  anyone, forever cached by whoever indexed them.

MIT licensed.
