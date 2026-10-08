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

## What the prototype does (v0.0.2, Android first)

- **Map**: MapLibre over OpenFreeMap's OSM vector tiles, no key.
- **Search and long-press**: places from OpenStreetMap via Photon.
- **Sign in with atproto OAuth.** You approve skymap on your own server's sign-in
  page; skymap never sees your password. It asks only to write its own layers,
  pins and events (granular `repo:` scopes), never posts, follows or profile
  changes. Tokens are DPoP-bound to a non-extractable key on the device. Records go
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
rankings, on the feed-generator model), routing.

## Sign-in (OAuth)

`app/src/oauth.ts` is the whole protocol, by hand: PAR, PKCE (S256), DPoP with
server nonces, the mandatory checks on the callback (`state`, `iss`) and token
response (`sub` is the account we started with, `atproto` scope granted, DPoP
token type), single-flight refresh (refresh tokens are single-use), revocation on
sign-out.

| Where | client_id | Redirect |
|---|---|---|
| Android app | `https://skymap.jason-edelman.org/oauth-client-metadata.json` (served from `site/`) | `org.jason-edelman.skymap:/oauth/callback`, caught by the deep-link plugin |
| Browser (dev) | the spec's loopback client, `http://localhost?...` | `http://127.0.0.1:1420/` |

The native client needs its metadata online before anyone can sign in:

```bash
npx wrangler deploy        # from the repo root; serves site/ at skymap.jason-edelman.org
curl https://skymap.jason-edelman.org/oauth-client-metadata.json
```

For browser development, open `http://127.0.0.1:1420` (not `localhost`: the
loopback redirect lands on 127.0.0.1, and storage is per-origin).

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
app/src-tauri/     Tauri 2 shell: packages the client for Android; geolocation, system browser, deep links
site/              skymap.jason-edelman.org: OAuth client metadata + landing page (wrangler.jsonc)
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
- **Granular scopes**: bsky.social accepts `repo:` scopes at the authorization
  request; that the issued token enforces them hasn't been observed yet (the full
  sign-in needs a human with a real password). `repo:community.lexicon.calendar.event`
  also lets skymap edit events other apps wrote to your account.
- **Public Photon and OpenFreeMap** are fine for a prototype, not for a product
  (fair-use limits, no SLA). Self-host Photon; move tiles to Protomaps on R2.
- **Everything outside Tables is public**: pins, layers and events are readable by
  anyone, forever cached by whoever indexed them.

MIT licensed.
