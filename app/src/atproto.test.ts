import { createRecord, login, parseAtUri, pdsFromDidDocument, resolveIdentity, type Fetch } from "./atproto";

const DID = "did:plc:5y6kop75jnvkbujbubrhj6e3";
const PDS = "https://discina.us-west.host.bsky.network";
const didDoc = {
  id: DID,
  alsoKnownAs: ["at://claude.jason-edelman.org"],
  service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS + "/" }],
};

function fakeFetch(routes: Record<string, (init?: RequestInit) => [number, unknown]>, calls: string[] = []): Fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    const [status, body] = routes[key](init);
    return new Response(JSON.stringify(body), { status });
  }) as Fetch;
}

const identityRoutes = {
  "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle": () => [200, { did: DID }] as [number, unknown],
  [`https://plc.directory/${DID}`]: () => [200, didDoc] as [number, unknown],
};

describe("identity", () => {
  it("resolves handle -> DID -> PDS and strips the trailing slash", async () => {
    const id = await resolveIdentity(fakeFetch(identityRoutes), "@Claude.Jason-Edelman.org");
    expect(id).toEqual({ did: DID, handle: "claude.jason-edelman.org", pds: PDS });
  });
  it("needs an atproto PDS service", () => {
    expect(() => pdsFromDidDocument({ service: [] })).toThrow();
  });
});

describe("session", () => {
  it("logs in at the account's own PDS and refreshes once on ExpiredToken", async () => {
    let creates = 0;
    const calls: string[] = [];
    const f = fakeFetch(
      {
        ...identityRoutes,
        [`${PDS}/xrpc/com.atproto.server.createSession`]: () => [
          200,
          { did: DID, handle: "claude.jason-edelman.org", accessJwt: "a1", refreshJwt: "r1" },
        ],
        [`${PDS}/xrpc/com.atproto.server.refreshSession`]: (init) => {
          expect((init?.headers as Record<string, string>).authorization).toBe("Bearer r1");
          return [200, { accessJwt: "a2", refreshJwt: "r2" }];
        },
        [`${PDS}/xrpc/com.atproto.repo.createRecord`]: (init) => {
          creates++;
          const auth = (init?.headers as Record<string, string>).authorization;
          if (auth === "Bearer a1") return [400, { error: "ExpiredToken", message: "expired" }];
          const body = JSON.parse(String(init?.body));
          expect(body.record.$type).toBe("org.jason-edelman.skymap.layer");
          return [200, { uri: `at://${DID}/org.jason-edelman.skymap.layer/abc`, cid: "bafy" }];
        },
      },
      calls,
    );
    const s = await login(f, "claude.jason-edelman.org", "xxxx-xxxx-xxxx-xxxx");
    expect(s.pds).toBe(PDS);
    const { ref, session } = await createRecord(f, s, "org.jason-edelman.skymap.layer", { name: "x", createdAt: "now" });
    expect(ref.uri).toContain("/org.jason-edelman.skymap.layer/abc");
    expect(session.accessJwt).toBe("a2");
    expect(creates).toBe(2);
    expect(calls.filter((c) => c.includes("refreshSession"))).toEqual([`POST ${PDS}/xrpc/com.atproto.server.refreshSession`]);
  });
});

it("parses record AT URIs", () => {
  expect(parseAtUri(`at://${DID}/org.jason-edelman.skymap.pin/3abc`)).toEqual({
    repo: DID,
    collection: "org.jason-edelman.skymap.pin",
    rkey: "3abc",
  });
});
