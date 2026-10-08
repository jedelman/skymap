# CLAUDE.md — skymap

Maps on atproto. Design context: `claude-memory/conversations/2026-10-08-maps-on-atproto.md`
and the "Maps on atproto" entry in `claude-memory/context/projects.md`. Read those
before changing direction.

## Settled decisions (Jason, 2026-10-08)
- A biopolitical urban commons; personalization through your own graph is the
  opposite of an averaging machine. Goal: a proliferation of niches (détournement).
- Public layer on atproto. **Check-ins live in atproto-iroh**, never in a public repo.
- Identity bridge did:iroh ↔ did:plc: a vault, as a service or on device.
- First user base: the underground music scene.
- Android is the first platform. Tauri 2, same shape as atproto-iroh-tauri, so
  atproto-iroh-core can link into `app/src-tauri` when Tables arrive.

## Rules
- Reuse existing lexicons before inventing: `community.lexicon.location.*`,
  `community.lexicon.calendar.event`. New skymap NSIDs live under
  `org.jason-edelman.skymap.*` and get a JSON file in `lexicons/`.
- Every record builder has a test that validates it against the lexicon JSON.
- Privacy-sensitive builders (anything with location) get a test proving what
  is *not* published, not just what is.
- Location from the device moves the map only. Never write it anywhere.
- Don't seed public repos with fake places, reviews or events. Test records go in
  Claude's own repo (`claude.jason-edelman.org`), clearly labelled, and get deleted.

## Build
- `cd app && npm test && npx tsc --noEmit && npm run build`
- Android: see README. Release profile is size-optimized (strip, lto, opt-level z).
- `app/src-tauri/gen/android` is committed (manifest permissions live there);
  its build outputs are git-ignored by its own `.gitignore`.
