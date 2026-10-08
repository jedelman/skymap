// Who to read. The relay already knows every repo that holds a given record
// type (com.atproto.sync.listReposByCollection), so finding people who map
// needs no skymap index: ask the relay, then intersect with who you follow.

import type { Fetch } from "./atproto";
import { NSID } from "./records";

const RELAY = "https://relay1.us-east.bsky.network";
const APPVIEW = "https://public.api.bsky.app";

export interface Person {
  did: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
  hasLayers: boolean;
  hasEvents: boolean;
  youFollow: boolean;
}

async function get<T>(f: Fetch, url: string): Promise<T> {
  const res = await f(url);
  if (!res.ok) throw new Error(`${new URL(url).pathname} → ${res.status}`);
  return (await res.json()) as T;
}

/** Every repo the relay knows holds `collection`, up to `maxPages` pages. */
export async function reposWith(f: Fetch, collection: string, maxPages = 10): Promise<{ dids: Set<string>; complete: boolean }> {
  const dids = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const u = new URL("/xrpc/com.atproto.sync.listReposByCollection", RELAY);
    u.searchParams.set("collection", collection);
    u.searchParams.set("limit", "1000");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await get<{ repos: { did: string }[]; cursor?: string }>(f, u.toString());
    for (const r of res.repos) dids.add(r.did);
    if (!res.cursor || res.repos.length === 0) return { dids, complete: true };
    cursor = res.cursor;
  }
  return { dids, complete: false };
}

interface Profile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

/** Who `actor` follows on Bluesky (public), up to `maxPages` × 100. */
export async function followsOf(f: Fetch, actor: string, maxPages = 50): Promise<Profile[]> {
  const out: Profile[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const u = new URL("/xrpc/app.bsky.graph.getFollows", APPVIEW);
    u.searchParams.set("actor", actor);
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await get<{ follows: Profile[]; cursor?: string }>(f, u.toString());
    out.push(...res.follows);
    if (!res.cursor || res.follows.length === 0) break;
    cursor = res.cursor;
  }
  return out;
}

export async function profiles(f: Fetch, dids: string[]): Promise<Profile[]> {
  const out: Profile[] = [];
  for (let i = 0; i < dids.length; i += 25) {
    const u = new URL("/xrpc/app.bsky.actor.getProfiles", APPVIEW);
    for (const d of dids.slice(i, i + 25)) u.searchParams.append("actors", d);
    out.push(...(await get<{ profiles: Profile[] }>(f, u.toString())).profiles);
  }
  return out;
}

export interface Discovery {
  /** People you follow who publish skymap layers or events, layers first. */
  followed: Person[];
  /** Everyone else with skymap layers (hydrated up to a limit). */
  others: Person[];
  totalMappers: number;
  /** False when the relay lists were cut short. */
  complete: boolean;
}

export async function discover(f: Fetch, actor: string | null, othersLimit = 50): Promise<Discovery> {
  const [layers, events, follows] = await Promise.all([
    reposWith(f, NSID.layer),
    reposWith(f, NSID.event),
    actor ? followsOf(f, actor) : Promise.resolve([] as Profile[]),
  ]);
  const followedDids = new Set(follows.map((p) => p.did));
  const person = (p: Profile, youFollow: boolean): Person => ({
    did: p.did,
    handle: p.handle,
    displayName: p.displayName,
    avatar: p.avatar,
    hasLayers: layers.dids.has(p.did),
    hasEvents: events.dids.has(p.did),
    youFollow,
  });
  const followed = follows
    .filter((p) => layers.dids.has(p.did) || events.dids.has(p.did))
    .map((p) => person(p, true))
    .sort((a, b) => Number(b.hasLayers) - Number(a.hasLayers));
  const otherDids = [...layers.dids].filter((d) => !followedDids.has(d)).slice(0, othersLimit);
  const others = (await profiles(f, otherDids)).map((p) => person(p, false));
  return { followed, others, totalMappers: layers.dids.size, complete: layers.complete && events.complete };
}
