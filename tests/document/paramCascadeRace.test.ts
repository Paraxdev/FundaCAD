// A parameter cascade awaits a headless sketch solve; whatever lands in the document
// during that solve (a doc_set, an import, a version restore) must survive the commit.
import { describe, it, expect } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildReply, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

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
});
