// resolve.ts per entity kind with a parameter in every numeric field, ids on a fresh module, and implied joins.
import { describe, it, expect, vi } from "vitest";
import { resolveEntities, resolveNum, resolveRealEntities, toSketchEntity } from "../../src/sketch/resolve";
import { impliedJoins } from "../../src/sketch/relations";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { Feature, Params, SketchConstraint, SketchEntity } from "../../src/types";

type Sketch = Extract<Feature, { type: "sketch" }>;
const sketchOf = (entities: SketchEntity[], extra: Partial<Sketch> = {}): Sketch => ({ id: "f1", type: "sketch", plane: "XY", entities, ...extra });

const params: Params = { a: 101.5, b: 52.25, c: 113, d: 47.75, w: 12.5, h: 7.25, r: 4.5, ang: 37.5, n: 6, t: 3.5, pos: 0.4, bw: 20 };
const SRC = { kind: "sketchCurve", sketch: "s0", entity: "e0" } as const;
const place = { width: { ox: 1.5, oy: -2 } };

const rows: [string, SketchEntity, ResolvedEntity][] = [
  ["rectangle", { type: "rectangle", id: "e1", width: "w", height: "h", x: "a", y: "b", angle: "ang", construction: true, dimPlace: place },
    { type: "rectangle", id: "e1", width: 12.5, height: 7.25, x: 101.5, y: 52.25, angle: 37.5, construction: true, dimPlace: place }],
  ["rectangle without a centre or angle", { type: "rectangle", id: "e2", width: "w", height: 3 }, { type: "rectangle", id: "e2", width: 12.5, height: 3, x: 0, y: 0 }],
  ["circle", { type: "circle", id: "e3", radius: "r", x: "a", y: "b", dimPlace: { diameter: { ox: 2, oy: 1 } } },
    { type: "circle", id: "e3", radius: 4.5, x: 101.5, y: 52.25, dimPlace: { diameter: { ox: 2, oy: 1 } } }],
  ["circle without a centre", { type: "circle", id: "e4", radius: 2, construction: true }, { type: "circle", id: "e4", radius: 2, x: 0, y: 0, construction: true }],
  ["line", { type: "line", id: "e5", x1: "a", y1: "b", x2: "c", y2: "d", construction: true, dimPlace: { length: { ox: 0, oy: 3 } } },
    { type: "line", id: "e5", x1: 101.5, y1: 52.25, x2: 113, y2: 47.75, construction: true, dimPlace: { length: { ox: 0, oy: 3 } } }],
  ["arc", { type: "arc", id: "e6", x1: "a", y1: "b", x2: "c", y2: "d", mx: "w", my: "h", construction: true },
    { type: "arc", id: "e6", x1: 101.5, y1: 52.25, x2: 113, y2: 47.75, mx: 12.5, my: 7.25, construction: true }],
  ["spline", { type: "spline", id: "e7", points: [{ x: "a", y: "b" }, { x: 105, y: "d" }, { x: "c", y: 60 }] },
    { type: "spline", id: "e7", points: [{ x: 101.5, y: 52.25 }, { x: 105, y: 47.75 }, { x: 113, y: 60 }] }],
  ["bspline", { type: "bspline", id: "e8", poles: [{ x: "a", y: "b" }, { x: "c", y: "d" }, { x: 120, y: "h" }], degree: 2, closed: true, knots: [0, 0, 0, 1, 1, 1], construction: true },
    { type: "bspline", id: "e8", poles: [{ x: 101.5, y: 52.25 }, { x: 113, y: 47.75 }, { x: 120, y: 7.25 }], degree: 2, closed: true, knots: [0, 0, 0, 1, 1, 1], construction: true }],
  ["point", { type: "point", id: "e9", x: "a", y: "d", construction: true }, { type: "point", id: "e9", x: 101.5, y: 47.75, construction: true }],
  ["text with every option", { type: "text", id: "e10", text: "Ab", x: "a", y: "b", height: "t", angle: "ang", font: "Inter", style: "bold", align: "center", pathRef: "e5", positionOnPath: "pos", boxWidth: "bw", construction: true },
    { type: "text", id: "e10", text: "Ab", x: 101.5, y: 52.25, height: 3.5, angle: 37.5, font: "Inter", style: "bold", align: "center", pathRef: "e5", positionOnPath: 0.4, boxWidth: 20, construction: true }],
  ["text with none", { type: "text", id: "e11", text: "c", height: 2 }, { type: "text", id: "e11", text: "c", x: 0, y: 0, height: 2, angle: 0 }],
  ["polygon", { type: "polygon", id: "e12", x: "a", y: "b", radius: "r", sides: "n", angle: "ang", construction: true, dimPlace: { radius: { ox: 1, oy: 1 } } },
    { type: "polygon", id: "e12", x: 101.5, y: 52.25, radius: 4.5, sides: 6, angle: 37.5, construction: true, dimPlace: { radius: { ox: 1, oy: 1 } } }],
  ["slot", { type: "slot", id: "e13", x1: "a", y1: "b", x2: "c", y2: "d", width: "t", construction: true, dimPlace: { width: { ox: 0, oy: -1 } } },
    { type: "slot", id: "e13", x1: 101.5, y1: 52.25, x2: 113, y2: 47.75, width: 3.5, construction: true, dimPlace: { width: { ox: 0, oy: -1 } } }],
  ["stale projected", { type: "projected", id: "e14", source: SRC, curve: { kind: "line", x1: 100, y1: 50, x2: 108, y2: 56 }, stale: true, construction: true },
    { type: "projected", id: "e14", source: SRC, curve: { kind: "line", x1: 100, y1: 50, x2: 108, y2: 56 }, stale: true, construction: true }],
  ["live projected", { type: "projected", id: "e15", source: SRC, curve: { kind: "circle", x: 104, y: 53, r: 2 } },
    { type: "projected", id: "e15", source: SRC, curve: { kind: "circle", x: 104, y: 53, r: 2 } }],
];

describe("resolveRealEntities and toSketchEntity", () => {
  it.each(rows)("resolve every field of a %s and write it back unchanged", (_n, doc, want) => {
    const [got] = resolveRealEntities(sketchOf([doc]), params);
    expect([got, toSketchEntity(got!)]).toEqual([want, want]);
  });

  it("resolves a whole sketch in order, the copies of a pattern only in resolveEntities", () => {
    const docs = rows.map((r) => r[1]);
    const sk = sketchOf(docs, { patterns: [{ id: "p1", type: "patternRect", sources: ["e9"], countX: 2, countY: 1, spacingX: 10, spacingY: 0 }] });
    const real = resolveRealEntities(sk, params);
    const all = resolveEntities(sk, params);
    expect([real, all.slice(0, real.length), all.slice(real.length).map((e) => [e.type, e.id])]).toEqual([rows.map((r) => r[2]), rows.map((r) => r[2]), [["point", "p1#0"]]]);
  });
});

describe("resolveNum", () => {
  it.each([["a number", 12.5, 12.5], ["a known name", "w", 12.5], ["a number written as text", "7.25", 7.25], ["an unknown name", "missing", 0], ["a name whose value is not a number", "bad", 0]] as const)(
    "resolves %s", (_n, x, want) => expect(resolveNum(x, { ...params, bad: "x" as unknown as number })).toBe(want));
});

describe("ids", () => {
  it("never hands an id-less entity the id of a saved one, on a fresh id counter", async () => {
    vi.resetModules();
    const fresh = await import("../../src/sketch/resolve");
    const first = fresh.resolveRealEntities(sketchOf([{ type: "point", x: 1, y: 2 }, { type: "point", id: "e4", x: 3, y: 4 }]), {});
    const second = fresh.resolveRealEntities(sketchOf([{ type: "point", id: "e2", x: 5, y: 6 }, { type: "point", x: 7, y: 8 }]), {});
    expect([first.map((e) => e.id), second.map((e) => e.id)]).toEqual([["e5", "e4"], ["e2", "e6"]]);
  });
});

describe("impliedJoins", () => {
  const A = { type: "line", id: "A", x1: 100, y1: 50, x2: 110, y2: 56 } as ResolvedEntity;
  const B = { type: "bspline", id: "B", poles: [{ x: 120, y: 60 }, { x: 115, y: 58 }, { x: 110, y: 56 }] } as ResolvedEntity;
  const C = { type: "line", id: "C", x1: 110, y1: 56, x2: 104, y2: 66 } as ResolvedEntity;
  const row = (entities: string[]) => ({ index: null, icon: "coincident", name: "Coincident", detail: expect.any(String), entities, state: null, implied: true });
  const co = (e1: string, e2: string): SketchConstraint => ({ type: "coincident", e1, p1: 1, e2, p2: 0 });

  it("lists a line end on an open bspline's end pole as one join", () => {
    expect(impliedJoins([A, B])).toEqual([row(["A", "B"])]);
  });
  it("lists nothing for a closed bspline or a construction line", () => {
    expect(impliedJoins([A, { ...B, closed: true } as ResolvedEntity])).toEqual([]);
    expect(impliedJoins([{ ...A, construction: true } as ResolvedEntity, B])).toEqual([]);
  });
  it("leaves out a join that recorded coincidents already tie together, in any order", () => {
    expect(impliedJoins([A, B, C], [co("C", "B"), co("A", "B")])).toEqual([]);
    expect(impliedJoins([A, B, C], [co("A", "B")])).toEqual([row(["A", "B", "C"])]);
    expect(impliedJoins([A, B, C], [])).toEqual([row(["A", "B", "C"])]);
  });
});
