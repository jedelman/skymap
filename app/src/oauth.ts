// atproto OAuth for a public client: PAR + PKCE + DPoP, per
// https://atproto.com/specs/oauth. Written out by hand rather than pulled
// from @atproto/oauth-client so every step that touches a credential is
// readable in one file.
//
// The DPoP private key is a non-extractable WebCrypto key. Tokens are bound
// to it, so a token copied out of storage is useless without the key, and
// the key can't be copied out at all.

import { fetchDidDocument, handleFromDidDocument, pdsFromDidDocument, resolveHandle, type Fetch } from "./atproto";

// ---------- encoding + crypto helpers ----------

const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export const sha256 = async (s: string) => b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = random(32);
  return { verifier, challenge: await sha256(verifier) };
}

export interface DpopKey {
  id: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

export async function generateDpopKey(): Promise<DpopKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { id: random(12), privateKey: pair.privateKey, publicJwk: { kty, crv, x, y } };
}

/** htu is the request URL without query or fragment (RFC 9449 §4.2). */
export function htu(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

export async function dpopProof(key: DpopKey, method: string, url: string, nonce?: string, accessToken?: string): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk };
  const payload: Record<string, unknown> = {
    jti: random(16),
    htm: method,
    htu: htu(url),
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) payload.nonce = nonce;
  if (accessToken) payload.ath = await sha256(accessToken);
  const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  // WebCrypto ECDSA signatures are already raw r||s, which is what JWS ES256 wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}

// ---------- storage ----------

/** Where keys live. IndexedDB in the app (it can hold non-extractable CryptoKeys); a Map in tests. */
export interface KeyStore {
  get(id: string): Promise<DpopKey | undefined>;
  put(key: DpopKey): Promise<void>;
  delete(id: string): Promise<void>;
}

export function memoryKeyStore(): KeyStore {
  const m = new Map<string, DpopKey>();
  return { get: async (id) => m.get(id), put: async (k) => void m.set(k.id, k), delete: async (id) => void m.delete(id) };
}

export function indexedDbKeyStore(dbName = "skymap-keys"): KeyStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("keys", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const tx = async <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const req = run(db.transaction("keys", mode).objectStore("keys"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).finally(() => db.close());
  };
  return {
    get: (id) => tx("readonly", (s) => s.get(id)) as Promise<DpopKey | undefined>,
    put: async (k) => void (await tx("readwrite", (s) => s.put(k))),
    delete: async (id) => void (await tx("readwrite", (s) => s.delete(id))),
  };
}

// ---------- client configuration ----------

export interface ClientConfig {
  clientId: string;
  redirectUri: string;
  scope: string;
}

export const SCOPE = "atproto transition:generic";

/**
 * The installed app: metadata hosted at the client_id URL; the redirect is a
 * custom scheme, the client_id hostname reversed (skymap.jason-edelman.org →
 * org.jason-edelman.skymap), caught by the deep-link plugin.
 */
export const NATIVE_CLIENT: ClientConfig = {
  clientId: "https://skymap.jason-edelman.org/oauth-client-metadata.json",
  redirectUri: "org.jason-edelman.skymap:/oauth/callback",
  scope: SCOPE,
};

/** Development in a browser: the spec's loopback client. No hosted metadata, short-lived sessions. */
export function loopbackClient(origin: string, scope = SCOPE): ClientConfig {
  const redirectUri = `${origin.replace("localhost", "127.0.0.1")}/`;
  const q = new URLSearchParams({ redirect_uri: redirectUri, scope });
  return { clientId: `http://localhost?${q}`, redirectUri, scope };
}

// ---------- DPoP-aware fetch ----------

type Nonces = Record<string, string>;

function isNonceError(res: Response, body: unknown): boolean {
  if (res.status !== 400 && res.status !== 401) return false;
  if ((body as { error?: string } | null)?.error === "use_dpop_nonce") return true;
  return /use_dpop_nonce/.test(res.headers.get("www-authenticate") ?? "");
}

/**
 * One request with a DPoP proof. Learns the server's nonce from every
 * response and retries once when the server says the nonce was missing or stale.
 */
async function dpopFetch(
  f: Fetch,
  key: DpopKey,
  nonces: Nonces,
  url: string,
  init: RequestInit & { accessToken?: string },
): Promise<{ res: Response; body: unknown }> {
  const origin = new URL(url).origin;
  const method = (init.method ?? "GET").toUpperCase();
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = new Headers(init.headers);
    headers.set("DPoP", await dpopProof(key, method, url, nonces[origin], init.accessToken));
    if (init.accessToken) headers.set("Authorization", `DPoP ${init.accessToken}`);
    const res = await f(url, { ...init, method, headers });
    const nonce = res.headers.get("dpop-nonce");
    if (nonce) nonces[origin] = nonce;
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (attempt === 0 && nonce && isNonceError(res, body)) continue;
    return { res, body };
  }
  throw new Error("unreachable");
}

const form = (o: Record<string, string>) => ({
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(o).toString(),
});

class OAuthError extends Error {
  constructor(public code: string | undefined, message: string) {
    super(message);
  }
}

function oauthFail(what: string, body: unknown): never {
  const b = body as { error?: string; error_description?: string } | null;
  throw new OAuthError(b?.error, `${what}: ${b?.error_description ?? b?.error ?? "failed"}`);
}

// ---------- discovery ----------

interface ServerMetadata {
  issuer: string;
  pushed_authorization_request_endpoint: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
}

async function getJson<T>(f: Fetch, url: string): Promise<T> {
  const res = await f(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

export async function authServerFor(f: Fetch, pds: string): Promise<ServerMetadata> {
  const pr = await getJson<{ authorization_servers?: string[] }>(f, `${pds}/.well-known/oauth-protected-resource`);
  const issuer = pr.authorization_servers?.[0];
  if (!issuer) throw new Error("PDS names no authorization server");
  const meta = await getJson<ServerMetadata>(f, `${issuer}/.well-known/oauth-authorization-server`);
  // The metadata must describe the server we asked: no redirection to another issuer.
  if (meta.issuer !== new URL(issuer).origin) throw new Error("Authorization server issuer mismatch");
  return meta;
}

// ---------- the flow ----------

export interface OAuthSession {
  did: string;
  handle: string;
  pds: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  scope: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  keyId: string;
  nonces: Nonces;
}

interface Pending {
  state: string;
  verifier: string;
  did: string;
  handle: string;
  pds: string;
  server: ServerMetadata;
  client: ClientConfig;
  keyId: string;
  nonces: Nonces;
  createdAt: number;
}

export interface Storage {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

const PENDING = (state: string) => `skymap.oauth.pending.${state}`;

/** Step 1: resolve the account, push the request, return the URL to open. */
export async function beginLogin(
  f: Fetch,
  store: Storage,
  keys: KeyStore,
  client: ClientConfig,
  handleOrDid: string,
): Promise<string> {
  const did = await resolveHandle(f, handleOrDid);
  const doc = await fetchDidDocument(f, did);
  const pds = pdsFromDidDocument(doc);
  const handle = handleFromDidDocument(doc) ?? did;
  const server = await authServerFor(f, pds);

  const key = await generateDpopKey();
  await keys.put(key);
  const { verifier, challenge } = await pkce();
  const state = random(16);
  const nonces: Nonces = {};

  const { res, body } = await dpopFetch(f, key, nonces, server.pushed_authorization_request_endpoint, {
    method: "POST",
    ...form({
      client_id: client.clientId,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      redirect_uri: client.redirectUri,
      scope: client.scope,
      login_hint: handleOrDid.trim().replace(/^@/, ""),
    }),
  });
  if (!res.ok) oauthFail("Authorization request refused", body);
  const requestUri = (body as { request_uri: string }).request_uri;

  const pending: Pending = { state, verifier, did, handle, pds, server, client, keyId: key.id, nonces, createdAt: Date.now() };
  store.set(PENDING(state), JSON.stringify(pending));
  const url = new URL(server.authorization_endpoint);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("request_uri", requestUri);
  return url.toString();
}

/** Is this URL the redirect coming back to us? */
export function isCallback(url: string, client: ClientConfig): boolean {
  const u = new URL(url);
  const r = new URL(client.redirectUri);
  return u.protocol === r.protocol && u.pathname === r.pathname && u.searchParams.has("state");
}

/** Is there a sign-in waiting for this callback? A callback replayed after use has none. */
export function hasPending(store: Storage, callbackUrl: string): boolean {
  const state = new URL(callbackUrl).searchParams.get("state");
  return !!state && store.get(PENDING(state)) !== null;
}

/** Step 2: the redirect came back. Verify it, trade the code for tokens, verify those. */
export async function finishLogin(f: Fetch, store: Storage, keys: KeyStore, callbackUrl: string): Promise<OAuthSession> {
  const params = new URL(callbackUrl).searchParams;
  const state = params.get("state");
  if (!state) throw new Error("Callback has no state");
  const raw = store.get(PENDING(state));
  if (!raw) throw new Error("Unknown or already-used sign-in attempt");
  store.set(PENDING(state), null); // one shot, whatever happens next
  const p = JSON.parse(raw) as Pending;

  if (params.get("error")) throw new OAuthError(params.get("error")!, params.get("error_description") ?? params.get("error")!);
  if (params.get("iss") !== p.server.issuer) throw new Error("Callback came from a different authorization server");
  const code = params.get("code");
  if (!code) throw new Error("Callback has no code");
  if (Date.now() - p.createdAt > 15 * 60_000) throw new Error("Sign-in took too long; try again");

  const key = await keys.get(p.keyId);
  if (!key) throw new Error("Signing key missing; try again");
  const { res, body } = await dpopFetch(f, key, p.nonces, p.server.token_endpoint, {
    method: "POST",
    ...form({
      grant_type: "authorization_code",
      code,
      redirect_uri: p.client.redirectUri,
      code_verifier: p.verifier,
      client_id: p.client.clientId,
    }),
  });
  if (!res.ok) oauthFail("Token exchange failed", body);
  const t = body as TokenResponse;
  verifyTokenResponse(t, p.did);

  return {
    did: p.did,
    handle: p.handle,
    pds: p.pds,
    issuer: p.server.issuer,
    tokenEndpoint: p.server.token_endpoint,
    revocationEndpoint: p.server.revocation_endpoint,
    clientId: p.client.clientId,
    scope: t.scope,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in ?? 300) * 1000,
    keyId: p.keyId,
    nonces: p.nonces,
  };
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  scope: string;
  sub: string;
}

/** The checks the spec makes mandatory: DPoP-bound, atproto scope, and the account we started with. */
export function verifyTokenResponse(t: TokenResponse, expectedDid: string): void {
  if (t.token_type?.toLowerCase() !== "dpop") throw new Error("Server issued a non-DPoP token");
  if (!t.scope?.split(" ").includes("atproto")) throw new Error("Server didn't grant the atproto scope");
  if (t.sub !== expectedDid) throw new Error("Signed in as a different account than requested");
}

/** Refresh tokens are single-use: concurrent refreshes would burn each other, so share one in flight. */
const inflight = new Map<string, Promise<OAuthSession>>();

export async function refreshSession(f: Fetch, keys: KeyStore, s: OAuthSession): Promise<OAuthSession> {
  if (!s.refreshToken) throw new Error("Session expired; sign in again");
  const running = inflight.get(s.refreshToken);
  if (running) return running;
  const job = (async () => {
    const key = await keys.get(s.keyId);
    if (!key) throw new Error("Signing key missing; sign in again");
    const nonces = { ...s.nonces };
    const { res, body } = await dpopFetch(f, key, nonces, s.tokenEndpoint, {
      method: "POST",
      ...form({ grant_type: "refresh_token", refresh_token: s.refreshToken!, client_id: s.clientId }),
    });
    if (!res.ok) oauthFail("Session refresh failed; sign in again", body);
    const t = body as TokenResponse;
    verifyTokenResponse(t, s.did);
    return {
      ...s,
      scope: t.scope,
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? s.refreshToken,
      expiresAt: Date.now() + (t.expires_in ?? 300) * 1000,
      nonces,
    };
  })();
  inflight.set(s.refreshToken, job);
  try {
    return await job;
  } finally {
    inflight.delete(s.refreshToken);
  }
}

/** A DPoP-authenticated XRPC call against the user's PDS. Refreshes once if the token is stale. */
export async function pdsCall<T>(
  f: Fetch,
  keys: KeyStore,
  s: OAuthSession,
  method: string,
  opts: { params?: Record<string, string>; body?: unknown },
  onSession: (s: OAuthSession) => void,
): Promise<T> {
  let session = s;
  if (Date.now() > session.expiresAt - 30_000) {
    session = await refreshSession(f, keys, session);
    onSession(session);
  }
  const key = await keys.get(session.keyId);
  if (!key) throw new Error("Signing key missing; sign in again");
  const url = new URL(`/xrpc/${method}`, session.pds);
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
  const init = (token: string): RequestInit & { accessToken: string } => ({
    method: opts.body !== undefined ? "POST" : "GET",
    headers: opts.body !== undefined ? { "content-type": "application/json" } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    accessToken: token,
  });

  let { res, body } = await dpopFetch(f, key, session.nonces, url.toString(), init(session.accessToken));
  if (res.status === 401 && /invalid_token/.test(res.headers.get("www-authenticate") ?? "")) {
    session = await refreshSession(f, keys, session);
    ({ res, body } = await dpopFetch(f, key, session.nonces, url.toString(), init(session.accessToken)));
  }
  onSession(session); // nonces may have moved even when nothing else did
  if (!res.ok) {
    const b = body as { error?: string; message?: string } | null;
    throw new Error(b?.message ?? b?.error ?? `${method} failed (${res.status})`);
  }
  return body as T;
}

/** Best-effort revoke, then forget the key. Signing out works offline too. */
export async function signOut(f: Fetch, keys: KeyStore, s: OAuthSession): Promise<void> {
  const key = await keys.get(s.keyId);
  if (key && s.revocationEndpoint && s.refreshToken) {
    await dpopFetch(f, key, { ...s.nonces }, s.revocationEndpoint, {
      method: "POST",
      ...form({ token: s.refreshToken, client_id: s.clientId }),
    }).catch(() => undefined);
  }
  await keys.delete(s.keyId);
}
