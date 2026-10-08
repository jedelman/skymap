import {
  b64url,
  beginLogin,
  dpopProof,
  finishLogin,
  generateDpopKey,
  hasPending,
  isCallback,
  loopbackClient,
  memoryKeyStore,
  NATIVE_CLIENT,
  pdsCall,
  sha256,
  type OAuthSession,
  type Storage,
} from "./oauth";
import type { Fetch } from "./atproto";

const DID = "did:plc:5y6kop75jnvkbujbubrhj6e3";
const PDS = "https://pds.example";
const AS = "https://auth.example";
const client = loopbackClient("http://localhost:1420", "atproto repo:org.jason-edelman.skymap.pin");

const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
const claims = (jwt: string) => ({ header: decode(jwt.split(".")[0]), payload: decode(jwt.split(".")[1]) });

function memStore(): Storage & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, get: (k) => m.get(k) ?? null, set: (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) };
}

/** A fake PDS + authorization server that enforces DPoP nonces the way the real one does. */
function fakeServer(opts: { sub?: string; scope?: string; tokenType?: string } = {}) {
  const nonce = { as: "n-as-1", pds: "n-pds-1" };
  const seen: { url: string; dpop: ReturnType<typeof claims>; body: URLSearchParams | null; auth?: string }[] = [];
  let access = "at-1";
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=me.example") return json(200, { did: DID });
    if (url === `https://plc.directory/${DID}`)
      return json(200, { alsoKnownAs: ["at://me.example"], service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }] });
    if (url === `${PDS}/.well-known/oauth-protected-resource`) return json(200, { authorization_servers: [AS] });
    if (url === `${AS}/.well-known/oauth-authorization-server`)
      return json(200, {
        issuer: AS,
        pushed_authorization_request_endpoint: `${AS}/oauth/par`,
        authorization_endpoint: `${AS}/oauth/authorize`,
        token_endpoint: `${AS}/oauth/token`,
        revocation_endpoint: `${AS}/oauth/revoke`,
      });
    const dpop = claims(headers.get("dpop")!);
    const body = typeof init?.body === "string" && !url.startsWith(PDS) ? new URLSearchParams(init.body) : null;
    seen.push({ url, dpop, body, auth: headers.get("authorization") ?? undefined });
    if (url.startsWith(AS)) {
      if (dpop.payload.nonce !== nonce.as) return json(400, { error: "use_dpop_nonce" }, { "DPoP-Nonce": nonce.as });
      if (url.endsWith("/par")) return json(201, { request_uri: "urn:req:1", expires_in: 60 }, { "DPoP-Nonce": nonce.as });
      if (url.endsWith("/token")) {
        access = body!.get("grant_type") === "refresh_token" ? "at-2" : "at-1";
        return json(
          200,
          { access_token: access, token_type: opts.tokenType ?? "DPoP", refresh_token: `rt-${access}`, expires_in: 300, scope: opts.scope ?? client.scope, sub: opts.sub ?? DID },
          { "DPoP-Nonce": nonce.as },
        );
      }
    }
    if (url.startsWith(PDS)) {
      if (dpop.payload.nonce !== nonce.pds) return json(401, { error: "use_dpop_nonce" }, { "DPoP-Nonce": nonce.pds, "WWW-Authenticate": 'DPoP error="use_dpop_nonce"' });
      if (headers.get("authorization") !== `DPoP ${access}`) return json(401, { error: "invalid_token" }, { "WWW-Authenticate": 'DPoP error="invalid_token"', "DPoP-Nonce": nonce.pds });
      return json(200, { uri: "at://x/y/z", cid: "c" }, { "DPoP-Nonce": nonce.pds });
    }
    throw new Error(`unexpected ${url}`);
  }) as Fetch;
  return { f, seen, rotate: () => (nonce.pds = "n-pds-2"), expire: () => (access = "revoked") };
}

async function signIn(server = fakeServer()) {
  const store = memStore();
  const keys = memoryKeyStore();
  const authUrl = await beginLogin(server.f, store, keys, client, "@me.example");
  const state = server.seen.find((s) => s.url.endsWith("/par") && s.body)!.body!.get("state")!;
  return { store, keys, authUrl, state, server };
}

describe("DPoP proofs", () => {
  it("sign with ES256, strip the query from htu, and bind the access token via ath", async () => {
    const key = await generateDpopKey();
    const jwt = await dpopProof(key, "POST", "https://pds.example/xrpc/a.b?x=1#frag", "nonce-1", "token-abc");
    const { header, payload } = claims(jwt);
    expect(header).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
    expect(header.jwk.d).toBeUndefined(); // public half only
    expect(payload).toMatchObject({ htm: "POST", htu: "https://pds.example/xrpc/a.b", nonce: "nonce-1", ath: await sha256("token-abc") });
    const pub = await crypto.subtle.importKey("jwk", header.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const [h, p, sig] = jwt.split(".");
    const raw = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, raw, new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  });

  it("the private key can't be exported", async () => {
    const key = await generateDpopKey();
    await expect(crypto.subtle.exportKey("jwk", key.privateKey)).rejects.toThrow();
  });

  it("PKCE uses S256 (RFC 7636 appendix B vector)", async () => {
    expect(await sha256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(b64url(new Uint8Array([251, 255]))).toBe("-_8");
  });
});

describe("clients", () => {
  it("loopback client follows the spec's localhost form", () => {
    const u = new URL(client.clientId);
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe("http://localhost/");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1420/");
    expect(client.redirectUri).toBe("http://127.0.0.1:1420/");
  });
  it("native redirect is the client_id hostname reversed, single slash", () => {
    const host = new URL(NATIVE_CLIENT.clientId).hostname.split(".").reverse().join(".");
    expect(NATIVE_CLIENT.redirectUri).toBe(`${host}:/oauth/callback`);
  });
  it("recognises its own callback and nothing else", () => {
    expect(isCallback("org.jason-edelman.skymap:/oauth/callback?state=s&code=c&iss=x", NATIVE_CLIENT)).toBe(true);
    expect(isCallback("org.jason-edelman.skymap:/elsewhere?state=s", NATIVE_CLIENT)).toBe(false);
    expect(isCallback("https://evil.example/oauth/callback?state=s", NATIVE_CLIENT)).toBe(false);
  });
});

describe("sign-in", () => {
  it("pushes a PKCE + DPoP request, learning the nonce, with the user's handle as login_hint", async () => {
    const { authUrl, server } = await signIn();
    const pars = server.seen.filter((s) => s.url.endsWith("/par"));
    expect(pars).toHaveLength(2); // first without nonce, retried with it
    const body = pars[1].body!;
    expect(body.get("code_challenge_method")).toBe("S256");
    expect(body.get("login_hint")).toBe("me.example");
    expect(body.get("client_id")).toBe(client.clientId);
    expect(body.get("code_verifier")).toBeNull(); // the verifier never leaves until the token step
    expect(new URL(authUrl).searchParams.get("request_uri")).toBe("urn:req:1");
  });

  it("finishes with a DPoP-bound session for the account it started with", async () => {
    const { store, keys, state, server } = await signIn();
    const s = await finishLogin(server.f, store, keys, `${client.redirectUri}?state=${state}&code=abc&iss=${encodeURIComponent(AS)}`);
    expect(s).toMatchObject({ did: DID, handle: "me.example", pds: PDS, accessToken: "at-1", issuer: AS });
    const tok = server.seen.find((x) => x.url.endsWith("/token"))!;
    expect(tok.body!.get("code_verifier")).toBeTruthy();
    expect(store.m.size).toBe(0); // pending state consumed
  });

  it("knows when a callback has already been used", async () => {
    const a = await signIn();
    const cb = `${client.redirectUri}?state=${a.state}&code=c&iss=${AS}`;
    expect(hasPending(a.store, cb)).toBe(true);
    await finishLogin(a.server.f, a.store, a.keys, cb);
    expect(hasPending(a.store, cb)).toBe(false);
  });

  it("refuses a callback from another issuer, a replay, or an unknown state", async () => {
    const a = await signIn();
    await expect(finishLogin(a.server.f, a.store, a.keys, `${client.redirectUri}?state=${a.state}&code=c&iss=https://evil.example`)).rejects.toThrow(/different authorization server/);
    await expect(finishLogin(a.server.f, a.store, a.keys, `${client.redirectUri}?state=${a.state}&code=c&iss=${AS}`)).rejects.toThrow(/Unknown/);
  });

  it("refuses tokens for a different account, without atproto, or not DPoP-bound", async () => {
    for (const [opts, msg] of [
      [{ sub: "did:plc:someoneelse" }, /different account/],
      [{ scope: "transition:generic" }, /atproto scope/],
      [{ tokenType: "Bearer" }, /non-DPoP/],
    ] as const) {
      const a = await signIn(fakeServer(opts));
      await expect(finishLogin(a.server.f, a.store, a.keys, `${client.redirectUri}?state=${a.state}&code=c&iss=${AS}`)).rejects.toThrow(msg);
    }
  });

  it("surfaces an error the user chose (denied consent)", async () => {
    const a = await signIn();
    await expect(finishLogin(a.server.f, a.store, a.keys, `${client.redirectUri}?state=${a.state}&error=access_denied&iss=${AS}`)).rejects.toThrow(/access_denied/);
  });
});

describe("authenticated PDS calls", () => {
  async function session() {
    const a = await signIn();
    const s = await finishLogin(a.server.f, a.store, a.keys, `${client.redirectUri}?state=${a.state}&code=c&iss=${AS}`);
    return { ...a, s };
  }

  it("send DPoP + ath, and follow a rotated PDS nonce", async () => {
    const { server, keys, s } = await session();
    let kept: OAuthSession = s;
    await pdsCall(server.f, keys, s, "com.atproto.repo.createRecord", { body: { a: 1 } }, (n) => (kept = n));
    server.rotate();
    await pdsCall(server.f, keys, kept, "com.atproto.repo.createRecord", { body: { a: 2 } }, (n) => (kept = n));
    const calls = server.seen.filter((x) => x.url.startsWith(PDS));
    const ok = calls.filter((c) => c.dpop.payload.nonce === "n-pds-1" || c.dpop.payload.nonce === "n-pds-2");
    expect(ok.at(-1)!.dpop.payload.nonce).toBe("n-pds-2");
    expect(ok.at(-1)!.dpop.payload.ath).toBe(await sha256("at-1"));
    expect(ok.at(-1)!.auth).toBe("DPoP at-1");
    expect(kept.nonces[PDS]).toBe("n-pds-2");
  });

  it("refresh an expired token before calling, and keep the new one", async () => {
    const { server, keys, s } = await session();
    let kept: OAuthSession = s;
    await pdsCall(server.f, keys, { ...s, expiresAt: Date.now() - 1 }, "com.atproto.repo.createRecord", { body: {} }, (n) => (kept = n));
    expect(kept.accessToken).toBe("at-2");
    expect(server.seen.find((x) => x.body?.get("grant_type") === "refresh_token")!.body!.get("refresh_token")).toBe("rt-at-1");
  });

  it("refresh once when the server rejects the token", async () => {
    const { server, keys, s } = await session();
    let kept: OAuthSession = s;
    server.expire();
    await pdsCall(server.f, keys, s, "com.atproto.repo.createRecord", { body: {} }, (n) => (kept = n));
    expect(kept.accessToken).toBe("at-2");
  });

  it("concurrent refreshes share one request (refresh tokens are single-use)", async () => {
    const { server, keys, s } = await session();
    const stale = { ...s, expiresAt: 0 };
    await Promise.all([1, 2, 3].map(() => pdsCall(server.f, keys, stale, "com.atproto.repo.createRecord", { body: {} }, () => {})));
    const refreshes = server.seen.filter((x) => x.body?.get("grant_type") === "refresh_token" && x.dpop.payload.nonce === "n-as-1");
    expect(refreshes).toHaveLength(1);
  });
});

describe("hosted client metadata", () => {
  it("matches what the app sends", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const meta = JSON.parse(readFileSync(join(__dirname, "../../site/oauth-client-metadata.json"), "utf8"));
    const { SKYMAP_SCOPE } = await import("./account");
    expect(meta.client_id).toBe(NATIVE_CLIENT.clientId);
    expect(meta.redirect_uris).toEqual([NATIVE_CLIENT.redirectUri]);
    expect(meta.scope).toBe(SKYMAP_SCOPE);
    expect(meta).toMatchObject({ application_type: "native", token_endpoint_auth_method: "none", dpop_bound_access_tokens: true });
    expect(meta.grant_types).toContain("authorization_code");
  });
});
