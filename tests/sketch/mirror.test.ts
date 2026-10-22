import { describe, expect, it } from "vitest";
import { mirrorCopies, reflectEntity, reflectPoint } from "../../src/sketch/mirror";
import { reflectedRect } from "../../src/sketch/pattern";
import type { ResolvedEntity } from "../../src/sketch/snap";

const a = { x: 3.5, y: -2 };
const b = { x: 9.5, y: 6.25 };

function round<T>(v: T): T {
  if (typeof v === "number") return (Math.round(v * 1e6) / 1e6 + 0) as T;
  if (Array.isArray(v)) return v.map(round) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) as T;
  return v;
}

describe("reflectPoint", () => {
  it("reflects across a slanted axis off the origin", () => {
    expect(round(reflectPoint(12, 1.5, a, b))).toEqual({ x: 4.210811, y: 7.164865 });
    expect(round(reflectPoint(-4.25, 7, a, b))).toEqual({ x: 14.45, y: -6.6 });
  });

  it("keeps a point on the axis where it is", () => {
    expect(round(reflectPoint(6.5, 2.125, a, b))).toEqual({ x: 6.5, y: 2.125 });
  });

  it("stays finite on a zero length axis and still reflects on a tiny one", () => {
    const p = reflectPoint(4.5, 1.25, a, a);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(round(p)).toEqual({ x: 2.5, y: -5.25 });
    const tiny = { x: a.x + 6e-4, y: a.y + 8.25e-4 };
    expect(round(reflectPoint(12, 1.5, a, tiny))).toEqual({ x: 4.210811, y: 7.164865 });
  });
});

describe("reflectEntity", () => {
  it("reflects a construction line and keeps it construction", () => {
    const e: ResolvedEntity = { type: "line", id: "l1", x1: 12, y1: 1.5, x2: -4.25, y2: 7, construction: true };
    expect(round(reflectEntity(e, a, b, "n1"))).toEqual({
      type: "line",
      id: "n1",
      x1: 4.210811,
      y1: 7.164865,
      x2: 14.45,
      y2: -6.6,
      construction: true,
    });
  });

  it("moves a circle's centre and keeps its radius, dropping its dimension spot", () => {
    const e: ResolvedEntity = {
      type: "circle",
      id: "c1",
      radius: 2.75,
      x: 8,
      y: 9,
      dimPlace: { dx: 1, dy: 2 },
    } as ResolvedEntity;
    expect(round(reflectEntity(e, a, b, "n2"))).toEqual({
      type: "circle",
      id: "n2",
      radius: 2.75,
      x: 12.578378,
      y: 5.67027,
    });
  });

  it("turns an angled rectangle the way reflectedRect does", () => {
    const e: ResolvedEntity = { type: "rectangle", id: "r1", width: 6, height: 2.5, x: 10, y: 4, angle: 25 };
    expect(round(reflectEntity(e, a, b, "n3"))).toEqual(
      round({ type: "rectangle", id: "n3", ...reflectedRect(e, 6, 8.25), x: 7.205405, y: 6.032432 }),
    );
    expect(round((reflectEntity(e, a, b, "n3") as { angle: number }).angle)).toEqual(82.945253);
  });

  it("reflects an arc's ends and its through point", () => {
    const e: ResolvedEntity = { type: "arc", id: "a1", x1: 12, y1: 1.5, x2: 8, y2: 9, mx: 11, my: 11 };
    expect(round(reflectEntity(e, a, b, "n4"))).toEqual({
      type: "arc",
      id: "n4",
      x1: 4.210811,
      y1: 7.164865,
      x2: 12.578378,
      y2: 5.67027,
      mx: 13.556757,
      my: 9.140541,
    });
  });

  it("reflects spline points and B spline poles, keeping the rest of the B spline", () => {
    const sp: ResolvedEntity = {
      type: "spline",
      id: "s1",
      points: [
        { x: 2, y: 3 },
        { x: 5, y: -6 },
      ],
    };
    expect(round(reflectEntity(sp, a, b, "n5"))).toEqual({
      type: "spline",
      id: "n5",
      points: [
        { x: 8.718919, y: -1.886486 },
        { x: -0.767568, y: -1.805405 },
      ],
    });
    const bs: ResolvedEntity = {
      type: "bspline",
      id: "b1",
      poles: [
        { x: 2, y: 3 },
        { x: 5, y: -6 },
        { x: 11, y: 11 },
      ],
      degree: 2,
      closed: false,
      construction: true,
    };
    expect(round(reflectEntity(bs, a, b, "n6"))).toEqual({
      type: "bspline",
      id: "n6",
      poles: [
        { x: 8.718919, y: -1.886486 },
        { x: -0.767568, y: -1.805405 },
        { x: 13.556757, y: 9.140541 },
      ],
      degree: 2,
      closed: false,
      construction: true,
    });
  });

  it("moves a text anchor and keeps the string and its angle", () => {
    const e: ResolvedEntity = { type: "text", id: "t1", text: "R2", x: 8, y: 9, height: 3.5, angle: 12, font: "Sans" };
    expect(round(reflectEntity(e, a, b, "n7"))).toEqual({
      type: "text",
      id: "n7",
      text: "R2",
      x: 12.578378,
      y: 5.67027,
      height: 3.5,
      angle: 12,
      font: "Sans",
    });
  });

  it("reflects a point, a polygon and a slot as their own types", () => {
    const pt: ResolvedEntity = { type: "point", id: "p1", x: 14.75, y: -3 };
    expect(round(reflectEntity(pt, a, b, "n8"))).toEqual({ type: "point", id: "n8", x: -0.917568, y: 8.394595 });
    const pg: ResolvedEntity = { type: "polygon", id: "g1", x: 10, y: 4, radius: 3, sides: 6, angle: 15 };
    expect(round(reflectEntity(pg, a, b, "n9"))).toEqual({
      type: "polygon",
      id: "n9",
      x: 7.205405,
      y: 6.032432,
      radius: 3,
      sides: 6,
      angle: 92.945253,
    });
    const sl: ResolvedEntity = { type: "slot", id: "q1", x1: 2, y1: 3, x2: 5, y2: -6, width: 1.5 };
    expect(round(reflectEntity(sl, a, b, "n10"))).toEqual({
      type: "slot",
      id: "n10",
      x1: 8.718919,
      y1: -1.886486,
      x2: -0.767568,
      y2: -1.805405,
      width: 1.5,
    });
  });

  it("refuses projected geometry", () => {
    const e = { type: "projected", id: "pr", source: {}, curve: {} } as unknown as ResolvedEntity;
    expect(reflectEntity(e, a, b, "n11")).toBeNull();
  });

  it("gives the original back when reflected twice", () => {
    const e: ResolvedEntity = { type: "arc", id: "a1", x1: 12, y1: 1.5, x2: 8, y2: 9, mx: 11, my: 11 };
    expect(round(reflectEntity(reflectEntity(e, a, b, "x")!, a, b, "a1"))).toEqual(e);
  });
});

describe("mirrorCopies", () => {
  const axis: ResolvedEntity = { type: "line", id: "ax", x1: 3.5, y1: -2, x2: 9.5, y2: 6.25, construction: true };
  const ents: ResolvedEntity[] = [
    { type: "point", id: "p1", x: 14.75, y: -3 },
    axis,
    { type: "circle", id: "c1", radius: 2.75, x: 8, y: 9 },
    { type: "line", id: "l1", x1: 12, y1: 1.5, x2: -4.25, y2: 7 },
  ];
  const ends = { id: "ax", a, b };
  const ids = () => {
    let n = 0;
    return () => `m${++n}`;
  };

  it("makes nothing from an empty pick", () => {
    expect(mirrorCopies(ents, new Set(), ends, ids())).toEqual([]);
  });

  it("copies one entity", () => {
    expect(round(mirrorCopies(ents, new Set(["c1"]), ends, ids()))).toEqual([
      { type: "circle", id: "m1", radius: 2.75, x: 12.578378, y: 5.67027 },
    ]);
  });

  it("copies many in entity order with distinct ids and skips the axis", () => {
    const out = round(mirrorCopies(ents, new Set(["l1", "ax", "p1", "c1"]), ends, ids()));
    expect(out).toEqual([
      { type: "point", id: "m1", x: -0.917568, y: 8.394595 },
      { type: "circle", id: "m2", radius: 2.75, x: 12.578378, y: 5.67027 },
      { type: "line", id: "m3", x1: 4.210811, y1: 7.164865, x2: 14.45, y2: -6.6 },
    ]);
  });
});
