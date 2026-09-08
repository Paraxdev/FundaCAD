// The host backed by the real document store, and the promise that makes the
// test double worth having.
//
// A plugin's tests run against ./testing.ts. Those tests are worth exactly as
// much as the agreement between that double and this host, so the agreement is
// checked directly: the same script of ops is run through both, and the
// documents that come out are compared. Where they differ on purpose, the test
// says which and why, rather than letting the difference sit unremarked until a
// plugin finds it.
//
// The other half is the refusals. Six ops are not served here yet, and each one
// says which of the two gates stopped it: the broker refuses for a missing
// grant, this host refuses for a missing capability, and a plugin author needs
// to be able to tell "you did not ask for this" from "the app cannot do this
// yet".

import { describe, expect, it } from "vitest";

import { DocumentStore } from "../../src/document/store";
import { appHost, HostRefused } from "../../src/plugins/broker/appHost";
import { testHost } from "../../src/plugins/broker/testing";
import { createBroker } from "../../src/plugins/broker/broker";
import { allOpGrants, OPS } from "../../src/plugins/broker/ops";
import type { BrokerHost } from "../../src/plugins/broker/broker";
import type { CadDocument } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

/** A real DocumentStore over a geometry backend that never builds anything.
 *
 *  The document ops are bookkeeping over `document` and never reach the kernel,
 *  so a backend that answers nothing is the honest stand-in: it makes the ops
 *  that DO need geometry impossible to serve by accident, which is exactly the
 *  state this host is in. */
function store(): DocumentStore {
  const backend = {
    async rebuild() { return { ok: true, result: { bodies: [] } }; },
    async init() {},
    onStatus() { return () => {}; },
    onRebuildChunk() { return () => {}; },
    onProgress() { return () => {}; },
    async cancel() { return true; },
    connected: false,
  } as unknown as GeometryBackend;
  return new DocumentStore(backend, { parameters: {}, features: [] });
}

const broker = (host: BrokerHost) =>
  createBroker({ plugin: "under-test", grants: allOpGrants(), host });

/** One script of ops, run through whichever host. */
async function script(host: BrokerHost, steps: [string, unknown][]) {
  const b = broker(host);
  const out: unknown[] = [];
  for (const [op, params] of steps) {
    const r = await b.call(op, params);
    out.push(r.ok ? r.value : { refused: r.code, why: r.why });
  }
  return out;
}

/** The parts of a document the two hosts are expected to agree on. The store
 *  keeps more than the double does (a format version, visibility maps), and
 *  none of it is what a plugin asked about. */
const compared = (d: CadDocument) => ({
  parameters: d.parameters,
  features: d.features,
});

const STEPS: [string, unknown][] = [
  ["param_set", { name: "wall", expr: 3 }],
  ["feature_add", { feature: { type: "box", x: 40 } }],
  ["feature_add", { feature: { type: "cylinder", d: 8 } }],
  ["feature_update", { id: "f2", patch: { d: 10 } }],
  ["feature_add", { feature: { type: "box", id: "named" } }],
  ["feature_move", { id: "named", to: 0 }],
  ["feature_remove", { id: "f1" }],
  ["param_remove", { name: "wall" }],
];

describe("the app's host and the test double agree", () => {
  it("produce the same document from the same script", async () => {
    const s = store();
    const real = appHost({ store: s });
    const fake = testHost();

    const fromReal = await script(real, STEPS);
    const fromFake = await script(fake, STEPS);

    // Every step answered the same way, ids included. That is the claim a
    // plugin's tests rest on.
    expect(fromFake).toEqual(fromReal);
    expect(compared(fake.document())).toEqual(compared(s.document));
  });

  it("really did the work, so agreeing is not agreeing about nothing", async () => {
    // The control. Two hosts that both refused everything would pass the test
    // above.
    const s = store();
    await script(appHost({ store: s }), STEPS);
    expect(s.document.features.map((f) => f.id)).toEqual(["named", "f2"]);
    expect(s.document.parameters).toEqual({});
  });

  it("would notice if one of them drifted", async () => {
    // The second control, on the comparison itself: a document the double did
    // not produce must not compare equal.
    const s = store();
    await script(appHost({ store: s }), STEPS);
    const fake = testHost();
    await script(fake, STEPS.slice(0, 3));
    expect(compared(fake.document())).not.toEqual(compared(s.document));
  });
});

describe("what this host cannot do yet, it refuses by name", () => {
  const unserved = ["doc_open", "doc_save", "build", "inspect", "view", "export"] as const;

  it("names the capability, not just a failure", async () => {
    const b = broker(appHost({ store: store() }));
    for (const op of unserved) {
      const r = await b.call(op, { path: "x.funda" });
      expect(r.ok, op).toBe(false);
      expect(r.ok === false && r.code, op).toBe("failed");
      // "failed" on its own would be indistinguishable from a kernel fault.
      expect(r.ok === false && r.why, op).toContain(op);
    }
  });

  it("tells a missing capability apart from a missing permission", async () => {
    const host = appHost({ store: store() });
    // No grants at all: the broker stops it first, and says so.
    const poor = createBroker({ plugin: "poor", grants: [], host });
    expect(await poor.call("build")).toMatchObject({ code: "not-granted" });
    // Every grant: the broker lets it through and the host is what refuses.
    expect(await broker(host).call("build")).toMatchObject({ code: "failed" });
  });

  it("serves everything else", async () => {
    // The control for the list above: the ops NOT in it must not be refused for
    // being unserved, or the list has quietly grown.
    for (const op of OPS) {
      if ((unserved as readonly string[]).includes(op)) continue;
      // A fresh store per op, with one feature in it. Sharing one would make
      // this a test of the ORDER of the op table: feature_remove comes before
      // feature_move, and would delete the feature the move then looked for.
      const s = store();
      const b = broker(appHost({ store: s, featureTypes: () => ["box"] }));
      await b.call("feature_add", { feature: { type: "box", id: "f1" } });
      await b.call("param_set", { name: "p", expr: 1 });
      const r = await b.call(op, {
        document: { parameters: {}, features: [] },
        name: "p",
        expr: 1,
        feature: { type: "box" },
        id: "f1",
        patch: {},
        to: 0,
      });
      expect(r.ok, `${op}: ${r.ok === false ? r.why : ""}`).toBe(true);
    }
  });
});

describe("edits go through the store, not around it", () => {
  it("hands out a copy of the document, so a plugin cannot edit it in place", async () => {
    const s = store();
    const b = broker(appHost({ store: s }));
    await b.call("feature_add", { feature: { type: "box" } });

    const r = await b.call("doc_get");
    const stolen = (r.ok ? r.value : null) as CadDocument;
    stolen.features.length = 0;
    stolen.parameters.injected = 1;

    expect(s.document.features).toHaveLength(1);
    expect(s.document.parameters).toEqual({});
  });

  it("refuses a bad parameter expression by naming it", async () => {
    const b = broker(appHost({ store: store() }));
    const r = await b.call("param_set", { name: "wall", expr: "nope(" });
    expect(r.ok).toBe(false);
    // The store validates and returns a message; it must reach the plugin
    // rather than being flattened into "failed".
    expect(r.ok === false && r.why.length).toBeGreaterThan(4);
  });

  it("refuses an edit to a feature that is not there, and names what is", async () => {
    const s = store();
    const b = broker(appHost({ store: s }));
    await b.call("feature_add", { feature: { type: "box", id: "here" } });
    const r = await b.call("feature_remove", { id: "gone" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("here");
    expect(s.document.features).toHaveLength(1);
  });

  it("removes a field when the patch says null", async () => {
    const s = store();
    const b = broker(appHost({ store: s }));
    await b.call("feature_add", { feature: { type: "revolve", id: "r", angle: 90, axisEdge: "x" } });
    await b.call("feature_update", { id: "r", patch: { axisEdge: null } });
    expect(s.document.features[0]).not.toHaveProperty("axisEdge");
    expect(s.document.features[0]).toMatchObject({ angle: 90 });
  });
});

describe("HostRefused", () => {
  it("is an Error, so the broker turns it into a refusal rather than a crash", () => {
    expect(new HostRefused("x")).toBeInstanceOf(Error);
  });
});
