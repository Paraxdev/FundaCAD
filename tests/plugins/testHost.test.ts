// The app a plugin's tests get handed.
//
// A test double earns trust by being checkable against the real thing wherever
// the real thing is checkable, and by refusing loudly wherever it is not. Both
// halves are here: the id scheme is checked against DocumentStore.nextId, which
// is what ./appHost.ts uses and therefore what a compute plugin really meets,
// and the four ops that need the geometry kernel refuse rather than invent an
// answer.
//
// The refusal is the part worth being stubborn about. A double that returned a
// plausible bounding box would let a plugin's test pass while the plugin's
// arithmetic was wrong, and it would pass forever, because nothing in the test
// ever touched a solid.

import { describe, expect, it } from "vitest";

import storeTs from "../../src/document/store.ts?raw";
import { testBroker, TestHostError } from "../../src/plugins/broker/testing";
import type { CadDocument } from "../../src/types";

const value = <T>(r: { ok: boolean; value?: unknown; why?: string }): T => {
  if (!r.ok) throw new Error(`expected success, got: ${r.why}`);
  return r.value as T;
};

describe("feature ids follow the app, not the agent", () => {
  it("names them f1, f2, the way DocumentStore.nextId does", async () => {
    const b = testBroker();
    for (const type of ["box", "extrude", "revolve"]) {
      await b.call("feature_add", { feature: { type } });
    }
    expect(b.host.document().features.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
  });

  it("counts the way the store counts, which is not the lowest free number", async () => {
    // DocumentStore.nextId starts at `ids.size + 1` and climbs past anything
    // taken. plugins/FundaCAD.MCP/model.py takes the lowest free number instead, so a
    // gap gets reused there and not here. Pinned because the difference is
    // exactly the sort of thing a plugin author would otherwise discover by
    // having predicted an id.
    const b = testBroker();
    await b.call("feature_add", { feature: { type: "box" } });   // f1
    await b.call("feature_add", { feature: { type: "box" } });   // f2
    await b.call("feature_remove", { id: "f1" });
    const r = await b.call("feature_add", { feature: { type: "box" } });
    expect(value<{ id: string }>(r).id).toBe("f3");
  });

  it("is the same rule the store uses, read off the store itself", () => {
    // The drift guard. This double is only worth anything while it agrees with
    // the host it stands in for, and that host is ./appHost.ts calling
    // DocumentStore.nextId. Read rather than restated: if that method stops
    // being `f` plus a number counted from the size, this fails here rather
    // than in somebody's plugin.
    expect(storeTs, "could not read the store").toContain("nextId(): string {");
    expect(storeTs).toContain("let n = ids.size + 1;");
    expect(storeTs).toContain("while (ids.has(`f${n}`)) n++;");
  });

  it("refuses a duplicate id and a malformed one, and changes nothing", async () => {
    const b = testBroker();
    await b.call("feature_add", { feature: { type: "box", id: "mine" } });
    expect(await b.call("feature_add", { feature: { type: "box", id: "mine" } })).toMatchObject({
      ok: false,
      code: "failed",
    });
    expect(await b.call("feature_add", { feature: { type: "box", id: "9bad" } })).toMatchObject({
      ok: false,
      code: "failed",
    });
    expect(b.host.document().features.map((f) => f.id)).toEqual(["mine"]);
    // Control: a well-formed one does land.
    expect((await b.call("feature_add", { feature: { type: "box", id: "yours" } })).ok).toBe(true);
    expect(b.host.document().features.map((f) => f.id)).toEqual(["mine", "yours"]);
  });
});

describe("the timeline", () => {
  it("inserts at a position and appends past the end", async () => {
    const b = testBroker();
    await b.call("feature_add", { feature: { type: "box", id: "a" } });
    await b.call("feature_add", { feature: { type: "box", id: "b" } });
    await b.call("feature_add", { feature: { type: "box", id: "c" }, at: 1 });
    await b.call("feature_add", { feature: { type: "box", id: "d" }, at: 99 });
    expect(b.host.document().features.map((f) => f.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("moves a feature, clamping rather than falling off the end", async () => {
    const b = testBroker();
    for (const id of ["a", "b", "c"]) await b.call("feature_add", { feature: { type: "box", id } });
    await b.call("feature_move", { id: "a", to: 99 });
    expect(b.host.document().features.map((f) => f.id)).toEqual(["b", "c", "a"]);
  });

  it("merges a patch, and a null in it removes the field", async () => {
    const b = testBroker();
    await b.call("feature_add", { feature: { type: "revolve", id: "r", angle: 90, axisEdge: "x" } });
    await b.call("feature_update", { id: "r", patch: { angle: 180 } });
    expect(b.host.document().features[0]).toMatchObject({ angle: 180, axisEdge: "x" });
    await b.call("feature_update", { id: "r", patch: { axisEdge: null } });
    expect(b.host.document().features[0]).not.toHaveProperty("axisEdge");
  });

  it("replaces the whole body when asked, keeping id and type", async () => {
    const b = testBroker();
    await b.call("feature_add", { feature: { type: "revolve", id: "r", angle: 90, axisEdge: "x" } });
    await b.call("feature_update", { id: "r", patch: { angle: 45 }, replace: true });
    expect(b.host.document().features[0]).toEqual({ angle: 45, id: "r", type: "revolve" });
  });

  it("names what it has when asked for a feature it does not", async () => {
    const b = testBroker();
    await b.call("feature_add", { feature: { type: "box", id: "here" } });
    const r = await b.call("feature_remove", { id: "gone" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("here");
  });
});

describe("parameters", () => {
  it("writes both the table and the derived cache", async () => {
    const b = testBroker();
    await b.call("param_set", { name: "wall", expr: 2.4 });
    const doc = b.host.document();
    expect(doc.parameters.wall).toBe(2.4);
    expect(doc.paramDefs?.wall).toEqual({ expr: "2.4", value: 2.4, unit: "mm" });
  });

  it("says plainly that it does not evaluate expressions", async () => {
    const b = testBroker();
    await b.call("param_set", { name: "wall", expr: 2 });
    const r = await b.call("param_set", { name: "half", expr: "wall/2" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("takes numbers, not expressions");
    // Control: a numeric string is still a number and still works.
    expect((await b.call("param_set", { name: "third", expr: "3" })).ok).toBe(true);
    expect(b.host.document().parameters.third).toBe(3);
  });

  it("removes from both places", async () => {
    const b = testBroker();
    await b.call("param_set", { name: "wall", expr: 2 });
    await b.call("param_remove", { name: "wall" });
    const doc = b.host.document();
    expect(doc.parameters).toEqual({});
    expect(doc.paramDefs).toEqual({});
  });
});

describe("the pretend disk", () => {
  it("opens what was put there and saves back", async () => {
    const start: CadDocument = { parameters: { w: 10 }, features: [] };
    const b = testBroker({ files: { "in.funda": JSON.stringify(start) } });
    expect((await b.call("doc_open", { path: "in.funda" })).ok).toBe(true);
    expect(b.host.document().parameters).toEqual({ w: 10 });
    await b.call("feature_add", { feature: { type: "box", id: "a" } });
    await b.call("doc_save", { path: "out.funda" });
    expect(JSON.parse(b.host.files()["out.funda"]!).features).toHaveLength(1);
  });

  it("refuses a path that is not there", async () => {
    const b = testBroker();
    expect(await b.call("doc_open", { path: "nope.funda" })).toMatchObject({
      ok: false,
      code: "failed",
    });
  });
});

describe("the ops that need a kernel", () => {
  it("refuse by default, naming the option to set", async () => {
    const b = testBroker();
    for (const op of ["build", "inspect", "view", "export"] as const) {
      const r = await b.call(op);
      expect(r.ok, op).toBe(false);
      expect(r.ok === false && r.why).toContain(`answers: { ${op}:`);
    }
  });

  it("answer from what the test supplied", async () => {
    const b = testBroker({ answers: { build: { bodies: ["body1"] } } });
    expect(value<{ bodies: string[] }>(await b.call("build")).bodies).toEqual(["body1"]);
  });

  it("can answer as a function of the arguments", async () => {
    const b = testBroker({
      answers: { view: (args) => ({ width: args.width ?? 512 }) },
    });
    expect(value(await b.call("view", { width: 200 }))).toEqual({ width: 200 });
    expect(value(await b.call("view"))).toEqual({ width: 512 });
  });
});

describe("the double does not leak its state", () => {
  it("hands out a copy of the document", async () => {
    const b = testBroker();
    await b.call("feature_add", { feature: { type: "box", id: "a" } });
    const stolen = b.host.document();
    stolen.features.length = 0;
    stolen.parameters.injected = 1;
    expect(b.host.document().features).toHaveLength(1);
    expect(b.host.document().parameters).toEqual({});
  });

  it("hands out a copy of the disk", async () => {
    const b = testBroker({ files: { "a.funda": "{}" } });
    const stolen = b.host.files();
    delete stolen["a.funda"];
    expect(Object.keys(b.host.files())).toEqual(["a.funda"]);
  });

  it("does not keep the document it was constructed with", async () => {
    const start: CadDocument = { parameters: {}, features: [] };
    const b = testBroker({ document: start });
    await b.call("feature_add", { feature: { type: "box" } });
    expect(start.features).toHaveLength(0);
  });

  it("records only the calls that got through", async () => {
    const b = testBroker({ grants: ["document.read"] });
    await b.call("doc_get");
    await b.call("doc_new");
    await b.call("not-an-op");
    expect(b.host.calls().map((c) => c.op)).toEqual(["doc_get"]);
  });
});

describe("TestHostError", () => {
  it("is what a refused edit is, so a test can tell it from a bug", () => {
    expect(new TestHostError("x")).toBeInstanceOf(Error);
  });
});
