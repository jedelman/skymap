// Minimal atproto client: identity resolution, app-password sessions, and
// repo record reads/writes against the user's own PDS. No SDK on purpose;
// the surface we need is small and every call here is plain XRPC.

const PUBLIC_APPVIEW = "https://public.api.bsky.app";
const PLC_DIRECTORY = "https://plc.directory";

export type Fetch = typeof fetch;

export interface Session {
  did: string;
  handle: string;
  pds: string;
  accessJwt: string;
  refreshJwt: string;
}

export interface RepoRecord<T = unknown> {
  uri: string;
  cid: string;
  value: T;
}

export class XrpcError extends Error {
  constructor(
    public status: number,
    public error: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

async function xrpc<T>(
  f: Fetch,
  base: string,
  method: string,
  opts: { params?: Record<string, string>; body?: unknown; token?: string; post?: boolean } = {},
): Promise<T> {
  const url = new URL(`/xrpc/${method}`, base);
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await f(url.toString(), {
    method: opts.post || opts.body !== undefined ? "POST" : "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new XrpcError(res.status, json.error, json.message ?? `${method} failed (${res.status})`);
  return json as T;
}

export function normalizeHandle(input: string): string {
  return input.trim().replace(/^@/, "").toLowerCase();
}

export async function resolveHandle(f: Fetch, handleOrDid: string): Promise<string> {
  const h = normalizeHandle(handleOrDid);
  if (h.startsWith("did:")) return h;
  const out = await xrpc<{ did: string }>(f, PUBLIC_APPVIEW, "com.atproto.identity.resolveHandle", {
    params: { handle: h },
  });
  return out.did;
}

interface DidDocument {
  alsoKnownAs?: string[];
  service?: { id: string; type: string; serviceEndpoint: string }[];
}

export async function fetchDidDocument(f: Fetch, did: string): Promise<DidDocument> {
  let url: string;
  if (did.startsWith("did:plc:")) url = `${PLC_DIRECTORY}/${did}`;
  else if (did.startsWith("did:web:")) url = `https://${did.slice("did:web:".length)}/.well-known/did.json`;
  else throw new Error(`Unsupported DID method: ${did}`);
  const res = await f(url);
  if (!res.ok) throw new Error(`Could not resolve ${did} (${res.status})`);
  return (await res.json()) as DidDocument;
}

export function pdsFromDidDocument(doc: DidDocument): string {
  const svc = doc.service?.find((s) => s.id.endsWith("#atproto_pds") && s.type === "AtprotoPersonalDataServer");
  if (!svc) throw new Error("DID document has no atproto PDS service");
  return svc.serviceEndpoint.replace(/\/$/, "");
}

export function handleFromDidDocument(doc: DidDocument): string | undefined {
  const aka = doc.alsoKnownAs?.find((a) => a.startsWith("at://"));
  return aka?.slice("at://".length);
}

export interface Identity {
  did: string;
  handle?: string;
  pds: string;
}

export async function resolveIdentity(f: Fetch, handleOrDid: string): Promise<Identity> {
  const did = await resolveHandle(f, handleOrDid);
  const doc = await fetchDidDocument(f, did);
  return { did, handle: handleFromDidDocument(doc), pds: pdsFromDidDocument(doc) };
}

export async function login(f: Fetch, identifier: string, appPassword: string): Promise<Session> {
  const id = await resolveIdentity(f, identifier);
  const out = await xrpc<{ did: string; handle: string; accessJwt: string; refreshJwt: string }>(
    f,
    id.pds,
    "com.atproto.server.createSession",
    { body: { identifier: id.did, password: appPassword } },
  );
  if (out.did !== id.did) throw new Error("PDS returned a session for a different account");
  return { did: out.did, handle: out.handle, pds: id.pds, accessJwt: out.accessJwt, refreshJwt: out.refreshJwt };
}

async function refresh(f: Fetch, s: Session): Promise<Session> {
  const out = await xrpc<{ accessJwt: string; refreshJwt: string }>(f, s.pds, "com.atproto.server.refreshSession", {
    post: true,
    token: s.refreshJwt,
  });
  return { ...s, accessJwt: out.accessJwt, refreshJwt: out.refreshJwt };
}

/** Runs an authed call, refreshing once on an expired access token. Returns the (possibly refreshed) session. */
async function authed<T>(
  f: Fetch,
  s: Session,
  call: (token: string) => Promise<T>,
): Promise<{ result: T; session: Session }> {
  try {
    return { result: await call(s.accessJwt), session: s };
  } catch (e) {
    if (!(e instanceof XrpcError) || e.error !== "ExpiredToken") throw e;
    const next = await refresh(f, s);
    return { result: await call(next.accessJwt), session: next };
  }
}

export async function listRecords<T>(
  f: Fetch,
  pds: string,
  did: string,
  collection: string,
  maxPages = 10,
): Promise<RepoRecord<T>[]> {
  const out: RepoRecord<T>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string> = { repo: did, collection, limit: "100" };
    if (cursor) params.cursor = cursor;
    const res = await xrpc<{ records: RepoRecord<T>[]; cursor?: string }>(f, pds, "com.atproto.repo.listRecords", {
      params,
    });
    out.push(...res.records);
    if (!res.cursor || res.records.length === 0) break;
    cursor = res.cursor;
  }
  return out;
}

export async function createRecord(
  f: Fetch,
  s: Session,
  collection: string,
  record: Record<string, unknown>,
): Promise<{ ref: { uri: string; cid: string }; session: Session }> {
  const { result, session } = await authed(f, s, (token) =>
    xrpc<{ uri: string; cid: string }>(f, s.pds, "com.atproto.repo.createRecord", {
      token,
      body: { repo: s.did, collection, record: { $type: collection, ...record } },
    }),
  );
  return { ref: result, session };
}

export async function deleteRecord(f: Fetch, s: Session, uri: string): Promise<Session> {
  const { collection, rkey } = parseAtUri(uri);
  const { session } = await authed(f, s, (token) =>
    xrpc(f, s.pds, "com.atproto.repo.deleteRecord", { token, body: { repo: s.did, collection, rkey } }),
  );
  return session;
}

export function parseAtUri(uri: string): { repo: string; collection: string; rkey: string } {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!m) throw new Error(`Not a record AT URI: ${uri}`);
  return { repo: m[1], collection: m[2], rkey: m[3] };
}
