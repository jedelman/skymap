// The signed-in account: picks the right OAuth client for where we're
// running, starts and finishes sign-in, and writes records as the user.

import { parseAtUri } from "./atproto";
import {
  beginLogin,
  finishLogin,
  hasPending,
  indexedDbKeyStore,
  isCallback,
  loopbackClient,
  NATIVE_CLIENT,
  pdsCall,
  signOut as revoke,
  type ClientConfig,
  type OAuthSession,
  type Storage,
} from "./oauth";
import { NSID } from "./records";

/**
 * Least privilege: skymap may write its own record types (layers, pins,
 * generators) and events, and nothing else. It can't post to your Bluesky
 * feed, follow anyone, or touch your profile.
 */
export const SKYMAP_SCOPE = ["atproto", `repo:${NSID.layer}`, `repo:${NSID.pin}`, `repo:${NSID.generator}`, `repo:${NSID.event}`].join(" ");

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function client(): ClientConfig {
  return isTauri() ? { ...NATIVE_CLIENT, scope: SKYMAP_SCOPE } : loopbackClient(location.origin, SKYMAP_SCOPE);
}

const store: Storage = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // Storage unavailable: sign-in can't survive a redirect, and will say so.
    }
  },
};
const keys = indexedDbKeyStore();
const SESSION = "skymap.oauth.session";
const f: typeof fetch = (...a) => fetch(...a);

export function loadSession(): OAuthSession | null {
  store.set("skymap.session", null); // the old app-password session, if any
  const raw = store.get(SESSION);
  return raw ? (JSON.parse(raw) as OAuthSession) : null;
}

export function saveSession(s: OAuthSession | null) {
  store.set(SESSION, s ? JSON.stringify(s) : null);
}

/** Starts sign-in: the system browser in the app, a same-tab redirect on the web. */
export async function startSignIn(handle: string): Promise<void> {
  if (!isTauri() && location.hostname === "localhost") {
    // The loopback redirect lands on 127.0.0.1, a different origin with its own
    // storage; sign-in has to start there too or the callback finds nothing.
    location.assign(location.href.replace("//localhost", "//127.0.0.1"));
    throw new Error("Reopened at 127.0.0.1 for sign-in; try again there");
  }
  const url = await beginLogin(f, store, keys, client(), handle);
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    location.assign(url);
  }
}

/**
 * Calls back with a finished session whenever the OAuth redirect arrives:
 * as a deep link in the app (including a cold start from the link), or as
 * this page's own URL on the web.
 */
export async function listenForSignIn(done: (s: OAuthSession) => void, fail: (e: Error) => void): Promise<() => void> {
  const handle = async (url: string) => {
    // Android can hand back the launching link again on a later start; once
    // used, a callback has no pending sign-in and is ignored, not an error.
    if (!isCallback(url, client()) || !hasPending(store, url)) return;
    try {
      const s = await finishLogin(f, store, keys, url);
      saveSession(s);
      done(s);
    } catch (e) {
      fail(e as Error);
    }
  };
  if (isTauri()) {
    const dl = await import("@tauri-apps/plugin-deep-link");
    for (const u of (await dl.getCurrent()) ?? []) await handle(u);
    return dl.onOpenUrl((urls) => urls.forEach(handle));
  }
  if (new URL(location.href).searchParams.has("state")) {
    const url = location.href;
    history.replaceState(null, "", location.pathname); // don't leave the code in the address bar
    await handle(url);
  }
  return () => {};
}

export async function signOut(s: OAuthSession): Promise<void> {
  saveSession(null);
  await revoke(f, keys, s);
}

/** Writes as the signed-in user. `onSession` keeps refreshed tokens and nonces. */
export async function createRecord(
  s: OAuthSession,
  collection: string,
  record: Record<string, unknown>,
  onSession: (s: OAuthSession) => void,
): Promise<{ uri: string; cid: string }> {
  return pdsCall(f, keys, s, "com.atproto.repo.createRecord", {
    body: { repo: s.did, collection, record: { $type: collection, ...record } },
  }, onSession);
}

export async function deleteRecord(s: OAuthSession, uri: string, onSession: (s: OAuthSession) => void): Promise<void> {
  const { collection, rkey } = parseAtUri(uri);
  await pdsCall(f, keys, s, "com.atproto.repo.deleteRecord", { body: { repo: s.did, collection, rkey } }, onSession);
}

/** Replaces a record, but only if it hasn't changed since we read it (swapRecord). */
export async function putRecord(
  s: OAuthSession,
  uri: string,
  cid: string,
  record: Record<string, unknown>,
  onSession: (s: OAuthSession) => void,
): Promise<{ uri: string; cid: string }> {
  const { collection, rkey } = parseAtUri(uri);
  return pdsCall(f, keys, s, "com.atproto.repo.putRecord", {
    body: { repo: s.did, collection, rkey, record: { $type: collection, ...record }, swapRecord: cid },
  }, onSession);
}
