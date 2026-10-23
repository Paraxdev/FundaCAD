import { describe, expect, it } from "vitest";
import { onshapeClient, type WebRequest, type WebResponse } from "../../plugins/FundaCAD.Onshape/client";
import { downloadName, downloadStep, pollTranslation, studiosOf } from "../../plugins/FundaCAD.Onshape/translate";
import { parseOnshapeUrl, type OnshapeLink } from "../../plugins/FundaCAD.Onshape/url";

const D = "e60c4803eaf2ac8be492c18e";
const W = "d2558da712764516cc9fec62";
const E = "6bed6b43463f6a46a37b4a22";
const E2 = "0000000000000000000000aa";
const keys = { access: "abcdefghi0123456789jkl", secret: "abcdefghijklmnopqrstuvwxzy0123456789abcdefghijkl" }; // gitleaks:allow, the example keys from Onshape's API key page

function reply(status: number, body?: unknown, extra: Partial<WebResponse> = {}): WebResponse {
  return {
    status,
    contentType: "application/json",
    location: null,
    retryAfter: null,
    text: body === undefined ? null : JSON.stringify(body),
    path: null,
    len: null,
    ...extra,
  };
}

/** A fake Onshape: routes by method and path, records every request. */
function server(routes: Record<string, (req: WebRequest) => WebResponse>) {
  const seen: WebRequest[] = [];
  let clock = 0;
  const slept: number[] = [];
  const transport = async (req: WebRequest) => {
    seen.push(req);
    const u = new URL(req.url);
    const route = routes[`${req.method} ${u.host}${u.pathname}`] ?? routes[`${req.method} ${u.pathname}`];
    if (!route) throw new Error(`no route for ${req.method} ${req.url}`);
    return route(req);
  };
  const sleep = async (ms: number) => {
    slept.push(ms);
    clock += ms;
  };
  const client = onshapeClient({ transport, keys, sleep });
  return { client, seen, slept, sleep, now: () => clock };
}

function header(req: WebRequest, name: string) {
  return req.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
}

function link(s: string): OnshapeLink {
  const l = parseOnshapeUrl(s);
  if ("error" in l) throw new Error(l.error);
  return l;
}

describe("waiting for a STEP translation", () => {
  it("polls ACTIVE, ACTIVE, DONE with backoff and returns the file id", async () => {
    const states = ["ACTIVE", "ACTIVE", "DONE"];
    const s = server({});
    let calls = 0;
    const get = async (tid: string) => {
      expect(tid).toBe("t1");
      const st = states[calls++]!;
      return { id: "t1", requestState: st, ...(st === "DONE" ? { resultExternalDataIds: ["x9"] } : {}) };
    };
    const id = await pollTranslation(get, { id: "t1", requestState: "ACTIVE" }, s);
    expect(id).toBe("x9");
    expect(s.slept).toEqual([1000, 2000, 3000]);
  });

  it("rejects with Onshape's reason when the translation fails", async () => {
    const s = server({});
    await expect(
      pollTranslation(
        async () => ({ id: "t", requestState: "FAILED", failureReason: "Empty part studio" }),
        { id: "t", requestState: "ACTIVE" },
        s,
      ),
    ).rejects.toThrow("Empty part studio");
  });

  it("gives up after the timeout", async () => {
    const s = server({});
    await expect(
      pollTranslation(
        async () => ({ id: "t", requestState: "ACTIVE" }),
        { id: "t", requestState: "ACTIVE" },
        { ...s, timeoutMs: 20_000 },
      ),
    ).rejects.toThrow("has not finished");
    expect(Math.max(...s.slept)).toBe(5000);
  });
});

describe("the signed client", () => {
  it("waits as long as a 429 asks before trying again", async () => {
    let n = 0;
    const s = server({
      [`GET /api/translations/t`]: () =>
        n++ === 0 ? reply(429, {}, { retryAfter: "2" }) : reply(200, { id: "t", requestState: "DONE" }),
    });
    const t = await s.client.json<{ requestState: string }>("GET", "https://cad.onshape.com/api/translations/t");
    expect(t.requestState).toBe("DONE");
    expect(s.slept).toEqual([2000]);
    expect(header(s.seen[0]!, "On-Nonce")).not.toBe(header(s.seen[1]!, "On-Nonce"));
  });

  it("signs again for the new host after a 307", async () => {
    const s = server({
      [`GET cad.onshape.com/api/documents/${D}`]: () =>
        reply(307, undefined, { location: `https://acme.onshape.com/api/documents/${D}?x=1` }),
      [`GET acme.onshape.com/api/documents/${D}`]: () => reply(200, { defaultWorkspace: { id: W } }),
    });
    const doc = await s.client.json<{ defaultWorkspace: { id: string } }>(
      "GET",
      `https://cad.onshape.com/api/documents/${D}`,
    );
    expect(doc.defaultWorkspace.id).toBe(W);
    expect(s.seen[1]!.url).toBe(`https://acme.onshape.com/api/documents/${D}?x=1`);
    expect(header(s.seen[0]!, "Authorization")).not.toBe(header(s.seen[1]!, "Authorization"));
  });

  it("never follows a redirect off Onshape", async () => {
    const s = server({
      [`GET /api/x`]: () => reply(307, undefined, { location: "https://evil.example.com/steal" }),
    });
    await expect(s.client.send("GET", "https://cad.onshape.com/api/x")).rejects.toThrow("evil.example.com");
    expect(s.seen).toHaveLength(1);
  });

  it("says the keys were refused on a 401 and never puts the secret in the message", async () => {
    const s = server({ [`GET /api/x`]: () => reply(401, { message: "Unauthenticated" }) });
    const err = await s.client.send("GET", "https://cad.onshape.com/api/x").catch((e: Error) => e);
    expect(String(err)).toContain("Onshape refused the keys");
    expect(String(err)).not.toContain(keys.secret);
    expect(JSON.stringify(s.seen)).not.toContain(keys.secret);
  });
});

describe("a part studio from a link", () => {
  const elements = [
    { id: E, name: "Bracket", elementType: "PARTSTUDIO" },
    { id: E2, name: "Assembly 1", elementType: "ASSEMBLY" },
  ];

  it("exports, polls and downloads the linked part studio", async () => {
    let polls = 0;
    const s = server({
      [`GET /api/documents/d/${D}/w/${W}/elements`]: () => reply(200, elements),
      [`POST /api/partstudios/d/${D}/w/${W}/e/${E}/translations`]: (req) => {
        expect(req.body).toEqual({ kind: "json", value: { formatName: "STEP", storeInDocument: false } });
        return reply(200, { id: "t1", requestState: "ACTIVE" });
      },
      [`GET /api/translations/t1`]: () =>
        reply(
          200,
          polls++
            ? { id: "t1", requestState: "DONE", resultExternalDataIds: ["x1"] }
            : { id: "t1", requestState: "ACTIVE" },
        ),
      [`GET /api/documents/d/${D}/externaldata/x1`]: (req) => {
        expect(req.saveAs).toBe("Bracket.step");
        return reply(200, undefined, { path: "C:/data/downloads/Bracket.step", len: 1234 });
      },
    });
    const studios = await studiosOf(s.client, link(`https://cad.onshape.com/documents/${D}/w/${W}/e/${E}`));
    expect(studios.map((x) => x.name)).toEqual(["Bracket"]);
    const path = await downloadStep(s.client, studios[0]!, s);
    expect(path).toBe("C:/data/downloads/Bracket.step");
    for (const req of s.seen) expect(header(req, "Authorization")).toMatch(/^On abcdefghi0123456789jkl:HmacSHA256:/);
  });

  it("lists every part studio of the default workspace for a bare document link", async () => {
    const s = server({
      [`GET /api/documents/${D}`]: () => reply(200, { defaultWorkspace: { id: W } }),
      [`GET /api/documents/d/${D}/w/${W}/elements`]: () =>
        reply(200, [...elements, { id: "0000000000000000000000bb", name: "Lid", elementType: "PARTSTUDIO" }]),
    });
    const studios = await studiosOf(s.client, link(`https://cad.onshape.com/documents/${D}`));
    expect(studios.map((x) => [x.name, x.wvm, x.wvmid])).toEqual([
      ["Bracket", "w", W],
      ["Lid", "w", W],
    ]);
  });

  it("refuses an assembly with a clear message", async () => {
    const s = server({ [`GET /api/documents/d/${D}/w/${W}/elements`]: () => reply(200, elements) });
    await expect(studiosOf(s.client, link(`https://cad.onshape.com/documents/${D}/w/${W}/e/${E2}`))).rejects.toThrow(
      "is an assembly",
    );
  });

  it("names the download after the part studio with only safe characters", () => {
    expect(downloadName("Bracket v2 (final)")).toBe("Bracket_v2_final_.step");
    expect(downloadName("../../etc")).toBe("etc.step");
    expect(downloadName("Ünïcode")).toBe("Unicode.step");
    expect(downloadName("")).toBe("part-studio.step");
  });
});
