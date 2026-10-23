// A parameter cascade awaits a headless sketch solve; whatever lands in the document
// during that solve (a doc_set, an import, a version restore) must survive the commit.
import { describe, it, expect } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildReply, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { LiveSessionHost } from "../../src/live/liveSession";

const okReply: RebuildReply = {
  ok: true,
  result: {
    mesh: { positions: new Float32Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0) },
    edges: [],
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  } as RebuildResult,
};

const backend = (): GeometryBackend =>
  ({
    rebuild: async () => okReply,
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  }) as unknown as GeometryBackend;

const sketch = (cx: number, cy: number, radius: number, value: number): Feature =>
  ({
    id: "s1",
    type: "sketch",
    plane: "XY",
    name: "Sketch1",
    entities: [{ type: "circle", id: "e1", cx, cy, radius }],
    constraints: [{ type: "radius", id: "c1", e: "e1", value }],
  }) as unknown as Feature;

const box = (id: string, length: number): Feature =>
  ({ id, type: "box", name: id, length, width: 6.5, height: 3.25 }) as unknown as Feature;

const doc = (): CadDocument => ({
  parameters: { r: 4.5 },
  paramDefs: {
    r: { expr: "4.5", value: 4.5, unit: "mm", target: { kind: "constraint", sketch: "s1", constraint: "c1" } },
  },
  features: [sketch(12.5, -7.25, 4.5, 4.5), box("b1", 9.75)],
});

const ticks = () =>
  new Promise<void>((res) => {
    let i = 0;
    const tick = () => (++i > 10 ? res() : void setTimeout(tick, 0));
    tick();
  });

type Sk = Extract<Feature, { type: "sketch" }>;

// Each solve waits for release(); `during(n)` runs while the nth solve is held.
function heldSolver(store: DocumentStore, during: (n: number) => void = () => {}) {
  const seen: Sk[] = [];
  store.headlessSolve = async (f, parameters) => {
    seen.push(structuredClone(f));
    during(seen.length);
    await ticks();
    return {
      entities: f.entities.map((e) => (e.type === "circle" ? { ...e, radius: parameters["r"]! } : e)),
    } as { entities: Sk["entities"] };
  };
  return seen;
}

const userDefs = (value: number, expr: string) => ({
  r: { expr, value, unit: "mm", target: { kind: "constraint", sketch: "s1", constraint: "c1" } },
});

describe("parameter cascade racing a document change", () => {
  it("applies the param and the solved sketch when nothing lands during the solve", async () => {
    const store = new DocumentStore(backend(), doc());
    const seen = heldSolver(store);
    expect(store.setParamExpr("r", "8.25")).toBeNull();
    await ticks();
    await ticks();
    expect(seen.length).toBe(1);
    expect(store.document.parameters).toEqual({ r: 8.25 });
    expect(store.document.paramDefs).toEqual(userDefs(8.25, "8.25"));
    expect(store.document.features).toEqual([sketch(12.5, -7.25, 8.25, 8.25), box("b1", 9.75)]);
  });

  it("keeps a doc_set that lands during the solve and applies the param on top of it", async () => {
    const store = new DocumentStore(backend(), doc());
    const seen = heldSolver(store, (n) => {
      if (n !== 1) return;
      store.loadDocument(
        { ...doc(), features: [sketch(-3.75, 21.5, 4.5, 4.5), box("b1", 14.5), box("b2", 2.75)] },
        { replace: true },
      );
    });
    store.setParamExpr("r", "8.25");
    await ticks();
    await ticks();
    await ticks();
    expect(seen.map((f) => f.entities)).toEqual([
      [{ type: "circle", id: "e1", cx: 12.5, cy: -7.25, radius: 4.5 }],
      [{ type: "circle", id: "e1", cx: -3.75, cy: 21.5, radius: 4.5 }],
    ]);
    expect(store.document.parameters).toEqual({ r: 8.25 });
    expect(store.document.features).toEqual([sketch(-3.75, 21.5, 8.25, 8.25), box("b1", 14.5), box("b2", 2.75)]);
  });

  it("keeps features imported during two solves and solves a third time", async () => {
    const store = new DocumentStore(backend(), doc());
    const issues: string[] = [];
    store.onParamSolveIssue = (id) => issues.push(id);
    const seen = heldSolver(store, (n) => {
      if (n <= 2) store.mutate((d) => void d.features.push(box(`imp${n}`, 1.5 * n)), true);
    });
    store.setParamExpr("r", "6.5");
    for (let i = 0; i < 5; i++) await ticks();
    expect(seen.length).toBe(3);
    expect(issues).toEqual([]);
    expect(store.document.features).toEqual([
      sketch(12.5, -7.25, 6.5, 6.5),
      box("b1", 9.75),
      box("imp1", 1.5),
      box("imp2", 3),
    ]);
  });

  it("gives up solving after three changed solves, still keeps every change and applies the param", async () => {
    const store = new DocumentStore(backend(), doc());
    const issues: string[] = [];
    store.onParamSolveIssue = (id) => issues.push(id);
    const seen = heldSolver(store, (n) => store.mutate((d) => void d.features.push(box(`imp${n}`, 1.5 * n)), true));
    store.setParamExpr("r", "6.5");
    for (let i = 0; i < 6; i++) await ticks();
    expect(seen.length).toBe(3);
    expect(issues).toEqual(["s1"]);
    expect(store.document.parameters).toEqual({ r: 6.5 });
    expect(store.document.features).toEqual([
      sketch(12.5, -7.25, 4.5, 6.5),
      box("b1", 9.75),
      box("imp1", 1.5),
      box("imp2", 3),
      box("imp3", 4.5),
    ]);
  });

  it("drops the cascade when another document opens during the solve, and the new one keeps its own state", async () => {
    const store = new DocumentStore(backend(), doc());
    const second: CadDocument = {
      parameters: { r: 2.25 },
      paramDefs: userDefs(2.25, "2.25") as NonNullable<CadDocument["paramDefs"]>,
      features: [sketch(30.5, 4.75, 2.25, 2.25), box("other", 5.5)],
    };
    const issues: string[] = [];
    store.onParamSolveIssue = (id) => issues.push(id);
    heldSolver(store, (n) => n === 1 && store.loadDocument(second));
    store.setParamExpr("r", "8.25");
    for (let i = 0; i < 4; i++) await ticks();
    expect(issues).toEqual([]);
    expect(store.document.parameters).toEqual({ r: 2.25 });
    expect(store.document.paramDefs).toEqual(userDefs(2.25, "2.25"));
    expect(store.document.features).toEqual(second.features);
  });

  it("drops the cascade when a replacing untitled load lands during the solve, and its undo brings the old one back unchanged", async () => {
    const store = new DocumentStore(backend(), doc());
    store.markSaved("D:/parts/bracket.funda");
    const lid: CadDocument = {
      parameters: { t: 2.75 },
      features: [sketch(-18.5, 9.25, 3.5, 3.5), box("lid", 31.5)],
    };
    const seen = heldSolver(store, (n) => n === 1 && store.loadDocument(lid, { replace: true, untitled: true }));
    store.setParamExpr("r", "8.25");
    for (let i = 0; i < 4; i++) await ticks();
    expect(seen.length).toBe(1);
    const state = () => ({
      path: store.filePath,
      parameters: store.document.parameters,
      paramDefs: store.document.paramDefs,
      features: store.document.features,
    });
    expect(state()).toEqual({
      path: null,
      parameters: { t: 2.75 },
      paramDefs: { t: { expr: "2.75", value: 2.75, unit: "mm" } },
      features: lid.features,
    });
    store.undo();
    expect(state()).toEqual({ path: "D:/parts/bracket.funda", ...doc() });
  });

  const lidDoc = (): CadDocument => ({
    parameters: { t: 2.75 },
    features: [sketch(-18.5, 9.25, 3.5, 3.5), box("lid", 31.5)],
  });
  const lidState = { path: null, parameters: { t: 2.75 }, paramDefs: { t: { expr: "2.75", value: 2.75, unit: "mm" } } };

  it.each([
    ["a second r edit", (s: DocumentStore) => s.setParamExpr("r", "8.25")],
    ["an added parameter", (s: DocumentStore) => s.addParam("q", "3.5")],
  ])("drops %s queued behind the solving one when an untitled load lands, warning once", async (_, second) => {
    const store = new DocumentStore(backend(), doc());
    store.markSaved("D:/parts/bracket.funda");
    const warnings: string[] = [];
    store.onWarning = (m) => warnings.push(m);
    heldSolver(store, (n) => n === 1 && store.loadDocument(lidDoc(), { replace: true, untitled: true }));
    store.setParamExpr("r", "7.75");
    second(store);
    for (let i = 0; i < 6; i++) await ticks();
    expect({
      path: store.filePath,
      parameters: store.document.parameters,
      paramDefs: store.document.paramDefs,
      features: store.document.features,
    }).toEqual({ ...lidState, features: lidDoc().features });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/parameter/i);
  });

  it("applies the change when an untitled load and its undo both land during the solve", async () => {
    const store = new DocumentStore(backend(), doc());
    store.markSaved("D:/parts/bracket.funda");
    const warnings: string[] = [];
    store.onWarning = (m) => warnings.push(m);
    heldSolver(store, (n) => {
      if (n !== 1) return;
      store.loadDocument(lidDoc(), { replace: true, untitled: true });
      store.undo();
    });
    store.setParamExpr("r", "8.25");
    for (let i = 0; i < 6; i++) await ticks();
    expect({
      path: store.filePath,
      parameters: store.document.parameters,
      paramDefs: store.document.paramDefs,
      features: store.document.features,
    }).toEqual({
      path: "D:/parts/bracket.funda",
      parameters: { r: 8.25 },
      paramDefs: userDefs(8.25, "8.25"),
      features: [sketch(12.5, -7.25, 8.25, 8.25), box("b1", 9.75)],
    });
    expect(warnings).toEqual([]);
  });

  // The same sketch and parameter as the bracket, moved, so a doc_set keeps the parameter's target.
  const incoming = (): CadDocument => ({ ...doc(), features: [sketch(-3.75, 21.5, 4.5, 4.5), box("lid-x", 30.5)] });
  it.each([
    ["doc_open", true, { path: null, ...incoming() }],
    ["doc_new", true, { path: null, ...incoming() }],
    [
      "doc_set",
      false,
      {
        path: "D:/parts/bracket.funda",
        parameters: { r: 8.25 },
        paramDefs: userDefs(8.25, "8.25"),
        features: [sketch(-3.75, 21.5, 8.25, 8.25), box("lid-x", 30.5)],
      },
    ],
  ])("an assistant's %s landing through the live session during the solve", async (note, replaces, expected) => {
    let reply: Record<string, unknown> = { ok: true, guests: [], proposals: [] };
    const geo = { ...backend(), session: async () => reply } as unknown as GeometryBackend;
    const store = new DocumentStore(geo, doc());
    store.markSaved("D:/parts/bracket.funda");
    const host = new LiveSessionHost(store, geo, () => true);
    host.start();
    await host.tick();
    heldSolver(store);
    const solve = store.headlessSolve!;
    let fired = false;
    store.headlessSolve = async (f, parameters) => {
      if (!fired) {
        fired = true;
        reply = {
          ok: true,
          guests: ["an assistant"],
          proposals: [{ id: "p1", name: "an assistant", note, document: incoming(), replaces }],
        };
        await host.tick();
        reply = { ok: true, guests: [], proposals: [] };
      }
      return solve(f, parameters);
    };
    store.setParamExpr("r", "8.25");
    for (let i = 0; i < 4; i++) await ticks();
    const after = {
      path: store.filePath,
      parameters: store.document.parameters,
      paramDefs: store.document.paramDefs,
      features: store.document.features,
    };
    await host.stop();
    expect(after).toEqual(expected);
  });
});
