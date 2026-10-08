import { listRecords, parseAtUri, pdsFromDidDocument, resolveIdentity, type Fetch } from "./atproto";

export const DID = "did:plc:5y6kop75jnvkbujbubrhj6e3";
export const PDS = "https://discina.us-west.host.bsky.network";
const didDoc = {
  id: DID,
  alsoKnownAs: ["at://claude.jason-edelman.org"],
  service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS + "/" }],
};

function fakeFetch(routes: Record<string, (url: string) => [number, unknown]>): Fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    const [status, body] = routes[key](url);
    return new Response(JSON.stringify(body), { status });
  }) as Fetch;
}

describe("identity", () => {
  it("resolves handle -> DID -> PDS and strips the trailing slash", async () => {
    const f = fakeFetch({
      "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle": () => [200, { did: DID }],
      [`https://plc.directory/${DID}`]: () => [200, didDoc],
    });
    expect(await resolveIdentity(f, "@Claude.Jason-Edelman.org")).toEqual({ did: DID, handle: "claude.jason-edelman.org", pds: PDS });
  });
  it("needs an atproto PDS service", () => {
    expect(() => pdsFromDidDocument({ service: [] })).toThrow();
  });
});

it("pages through listRecords until the cursor runs out", async () => {
  let page = 0;
  const f = fakeFetch({
    [`${PDS}/xrpc/com.atproto.repo.listRecords`]: (url) => {
      page++;
      const cursor = new URL(url).searchParams.get("cursor");
      return [200, cursor ? { records: [{ uri: "b", cid: "c", value: {} }] } : { records: [{ uri: "a", cid: "c", value: {} }], cursor: "next" }];
    },
  });
  expect((await listRecords(f, PDS, DID, "x.y.z")).map((r) => r.uri)).toEqual(["a", "b"]);
  expect(page).toBe(2);
});

it("parses record AT URIs", () => {
  expect(parseAtUri(`at://${DID}/org.jason-edelman.skymap.pin/3abc`)).toEqual({
    repo: DID,
    collection: "org.jason-edelman.skymap.pin",
    rkey: "3abc",
  });
});
