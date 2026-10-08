// Minimal atproto client for public reads: identity resolution and repo
// record listing against each author's own PDS. Writes are authenticated
// through OAuth (oauth.ts, account.ts). No SDK on purpose; the surface we
// need is small and every call here is plain XRPC.

const PUBLIC_APPVIEW = "https://public.api.bsky.app";
const PLC_DIRECTORY = "https://plc.directory";

export type Fetch = typeof fetch;

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
  opts: { params?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(`/xrpc/${method}`, base);
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
  const res = await f(url.toString());
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

export function parseAtUri(uri: string): { repo: string; collection: string; rkey: string } {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!m) throw new Error(`Not a record AT URI: ${uri}`);
  return { repo: m[1], collection: m[2], rkey: m[3] };
}
