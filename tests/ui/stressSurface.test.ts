import { describe, expect, it } from "vitest";
import {
  DRAWN_BUDGET,
  drawnCorner,
  engineHit,
  nearestVertex,
  refineLevel,
  refineSurface,
  type DrawnSurface,
  type EngineSurface,
} from "../../src/ui/stressSurface";
import type { Vec3 } from "../../src/types";

// Every shape sits off the origin, turned 30 degrees about Z and then 20 about X, so no test leans on an axis.
const OFFSET: Vec3 = [13.5, -7.25, 4.1];
const RZ = (30 * Math.PI) / 180;
const RX = (20 * Math.PI) / 180;

function place(p: Vec3): Vec3 {
  const x1 = p[0] * Math.cos(RZ) - p[1] * Math.sin(RZ);
  const y1 = p[0] * Math.sin(RZ) + p[1] * Math.cos(RZ);
  const z1 = p[2];
  const y2 = y1 * Math.cos(RX) - z1 * Math.sin(RX);
  const z2 = y1 * Math.sin(RX) + z1 * Math.cos(RX);
  return [x1 + OFFSET[0], y2 + OFFSET[1], z2 + OFFSET[2]];
}

function unplace(p: ArrayLike<number>, i: number): Vec3 {
  const x = p[i]! - OFFSET[0];
  const y2 = p[i + 1]! - OFFSET[1];
  const z2 = p[i + 2]! - OFFSET[2];
  const y1 = y2 * Math.cos(RX) + z2 * Math.sin(RX);
  const z1 = -y2 * Math.sin(RX) + z2 * Math.cos(RX);
  return [x * Math.cos(RZ) + y1 * Math.sin(RZ), -x * Math.sin(RZ) + y1 * Math.cos(RZ), z1];
}

function surface(points: Vec3[], indices: number[], extra: Partial<EngineSurface> = {}): EngineSurface {
  return {
    positions: points.flatMap(place),
    indices,
    vonMises: points.map((_, i) => 2 + ((i * 7) % 5) * 3.5),
    ...extra,
  };
}

const tetra = () =>
  surface(
    [
      [0, 0, 0],
      [12, 1, 0],
      [2, 9, 0.5],
      [3, 2, 11],
    ],
    [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3],
  );

// A 20 x 12 x 7 box, two triangles per side, each side its own B-rep face.
const BOX: Vec3 = [20, 12, 7];
function box(extra: Partial<EngineSurface> = {}): EngineSurface {
  const [X, Y, Z] = BOX;
  const pts: Vec3[] = [
    [0, 0, 0],
    [X, 0, 0],
    [X, Y, 0],
    [0, Y, 0],
    [0, 0, Z],
    [X, 0, Z],
    [X, Y, Z],
    [0, Y, Z],
  ];
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const indices = quads.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!]);
  const faceIds = quads.flatMap((_, i) => [i, i]);
  return surface(pts, indices, { faceIds, ...extra });
}

/** Two triangles hinged on the edge 0-1, folded `deg` degrees out of plane. */
function hinge(deg: number, faceIds: number[] | undefined): EngineSurface {
  const r = (deg * Math.PI) / 180;
  const pts: Vec3[] = [
    [0, 0, 0],
    [10, 0, 0],
    [4, 6, 0],
    [5, -6 * Math.cos(r), 6 * Math.sin(r)],
  ];
  return surface(pts, [0, 1, 2, 1, 0, 3], faceIds ? { faceIds } : {});
}

/** The new vertex of the edge 0-1, the first edge made, right after the old vertices. */
function hingeEdgePoint(d: DrawnSurface, old = 4): Vec3 {
  return [d.positions[old * 3]!, d.positions[old * 3 + 1]!, d.positions[old * 3 + 2]!];
}

function midpoint(s: EngineSurface, a: number, b: number): Vec3 {
  return [0, 1, 2].map((c) => (s.positions[a * 3 + c]! + s.positions[b * 3 + c]!) / 2) as Vec3;
}

function closeTo(a: ArrayLike<number>, b: ArrayLike<number>, tol: number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > tol) return false;
  return true;
}

describe("refineSurface", () => {
  it("quadruples the triangles each level and adds one vertex per edge", () => {
    const s = tetra();
    const counts = ([0, 1, 2] as const).map((l) => {
      const d = refineSurface(s, l);
      return [d.positions.length / 3, d.indices.length / 3, d.parent.length, d.local.length / 6, d.values.length];
    });
    expect(counts).toEqual([
      [4, 4, 4, 4, 4],
      [10, 16, 16, 16, 10],
      [34, 64, 64, 64, 34],
    ]);
  });

  it("returns level 0 as typed copies with each triangle its own parent at its own corners", () => {
    const s = tetra();
    const d = refineSurface(s, 0);
    expect({
      positions: closeTo(d.positions, s.positions, 1e-5),
      indices: [...d.indices],
      parent: [...d.parent],
      local: [...d.local.subarray(0, 6)],
      level: d.level,
      displacement: d.displacement,
    }).toEqual({
      positions: true,
      indices: [...(s.indices as number[])],
      parent: [0, 1, 2, 3],
      local: [0, 0, 1, 0, 0, 1],
      level: 0,
      displacement: undefined,
    });
  });

  it("keeps a box a box: every drawn vertex on its sides, the corners where they were", () => {
    const s = box();
    for (const level of [1, 2] as const) {
      const d = refineSurface(s, level);
      const off: number[] = [];
      for (let v = 0; v < d.positions.length / 3; v++) {
        const p = unplace(d.positions, v * 3);
        const toSide = Math.min(...p.map((x, i) => Math.min(Math.abs(x), Math.abs(x - BOX[i]!))));
        const outside = p.some((x, i) => x < -1e-4 || x > BOX[i]! + 1e-4);
        if (toSide > 1e-4 || outside) off.push(v);
      }
      expect(off).toEqual([]);
      expect(closeTo(d.positions.subarray(0, 24), s.positions, 1e-5)).toBe(true);
    }
  });

  it("rounds a faceted tube: its long edges are smooth and the folds between facets get gentler", () => {
    const n = 12;
    const pts: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      pts.push([8 * Math.cos(a), 8 * Math.sin(a), 0], [8 * Math.cos(a), 8 * Math.sin(a), 15]);
    }
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      indices.push(2 * i, 2 * j, 2 * j + 1, 2 * i, 2 * j + 1, 2 * i + 1);
    }
    const s = surface(pts, indices, { faceIds: indices.map(() => 4).slice(0, n * 2) });
    const d = refineSurface(s, 2);
    // A long edge's new vertex is pulled toward the axis; creased it would stay on the edge, at the full radius.
    const d1 = refineSurface(s, 1);
    // Triangle 0 is (0, 2, 3): its second edge, 2 to 3, is a long one and the second edge vertex made.
    const e = unplace(d1.positions, (24 + 1) * 3);
    const radius = Math.hypot(e[0], e[1]);
    expect(radius).toBeLessThan(7.9);
    expect(maxFoldDeg(d, (a, b) => sameZ(a, b))).toBeLessThan(30 / 2);
  });

  it("keeps a held face held: zero displacement on a side stays zero after two levels", () => {
    const pts = 8;
    const disp: number[] = [];
    for (let v = 0; v < pts; v++) {
      const held = v < 4;
      disp.push(held ? 0 : 0.3 + v * 0.05, held ? 0 : -0.2, held ? 0 : -1.5 + v * 0.1);
    }
    const s = box({ displacement: disp });
    const d = refineSurface(s, 2);
    const moved: number[] = [];
    for (let v = 0; v < d.positions.length / 3; v++) {
      const p = unplace(d.positions, v * 3);
      if (Math.abs(p[2]) > 1e-4) continue;
      const m = Math.hypot(d.displacement![v * 3]!, d.displacement![v * 3 + 1]!, d.displacement![v * 3 + 2]!);
      if (m !== 0) moved.push(v);
    }
    expect(moved).toEqual([]);
  });

  it("commutes with the deformation: refining the bent shape is the refined shape bent", () => {
    const disp = [0, 0, 0, 0.4, -0.1, -2, 0.2, 0.1, -1.1, 0.05, 0.3, -0.6];
    const s = { ...tetra(), displacement: disp };
    const scale = 2.5;
    const bent = { ...s, positions: Array.from(s.positions, (x, i) => x + scale * disp[i]!), displacement: undefined };
    const a = refineSurface(s, 2);
    const b = refineSurface(bent, 2);
    const drawn = Array.from(a.positions, (x, i) => x + scale * a.displacement![i]!);
    expect(closeTo(b.positions, drawn, 1e-4)).toBe(true);
  });

  it("keeps the engine's value at its vertices and every drawn value inside the engine's range", () => {
    const s = box();
    const vm = Array.from(s.vonMises);
    const d = refineSurface(s, 2);
    const min = Math.min(...vm);
    const max = Math.max(...vm);
    const inside = Array.from(d.values).every((x) => x >= min - 1e-6 && x <= max + 1e-6);
    expect({ old: closeTo(d.values.subarray(0, 8), vm, 1e-6), inside, peak: Math.max(...d.values) }).toEqual({
      old: true,
      inside: true,
      peak: Math.fround(max),
    });
  });

  it("creases a fold between two faces above 15 degrees and not below", () => {
    const at = (deg: number) => {
      const s = hinge(deg, [3, 8]);
      return closeTo(hingeEdgePoint(refineSurface(s, 1)), midpoint(s, 0, 1), 1e-5);
    };
    expect([at(14), at(16)]).toEqual([false, true]);
  });

  it("creases a fold inside one face, or with no faces sent, only above 40 degrees", () => {
    const at = (deg: number, faces: number[] | undefined) => {
      const s = hinge(deg, faces);
      return closeTo(hingeEdgePoint(refineSurface(s, 1)), midpoint(s, 0, 1), 1e-5);
    };
    expect([at(39, [5, 5]), at(41, [5, 5]), at(39, undefined), at(41, undefined)]).toEqual([false, true, false, true]);
  });

  it("creases an edge three triangles share", () => {
    const pts: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [4, 6, 0],
      [5, -6, 0.5],
      [6, 0.5, 6],
    ];
    const s = surface(pts, [0, 1, 2, 1, 0, 3, 0, 1, 4]);
    expect(closeTo(hingeEdgePoint(refineSurface(s, 1), 5), midpoint(s, 0, 1), 1e-5)).toBe(true);
  });

  it("shares no arrays between two results refined in a row", () => {
    const a = refineSurface(tetra(), 1);
    const s2 = box();
    const b = refineSurface(s2, 1);
    expect([a.positions.buffer === b.positions.buffer, a.indices.buffer === b.indices.buffer]).toEqual([false, false]);
    expect(b.indices.length / 3).toBe(48);
    expect(a.indices.length / 3).toBe(16);
  });
});

describe("engineHit and drawnCorner", () => {
  it("maps a hit on a drawn triangle to the engine triangle it lies in, the children tiling it whole", () => {
    const s = box();
    const d = refineSurface(s, 2);
    const area = new Map<number, number>();
    for (let t = 0; t < d.parent.length; t++) {
      const l = d.local.subarray(t * 6, t * 6 + 6);
      const twice = (l[2]! - l[0]!) * (l[5]! - l[1]!) - (l[4]! - l[0]!) * (l[3]! - l[1]!);
      area.set(d.parent[t]!, (area.get(d.parent[t]!) ?? 0) + Math.abs(twice) / 2);
    }
    expect([...area.values()].every((x) => Math.abs(x - 0.5) < 1e-6)).toBe(true);
    expect(area.size).toBe(12);
    const hits = [
      { tri: 0, w: [1, 0, 0] as Vec3 },
      { tri: 37, w: [0.2, 0.5, 0.3] as Vec3 },
      { tri: 191, w: [0.6, 0.1, 0.3] as Vec3 },
    ];
    for (const h of hits) {
      const e = engineHit(d, h.tri, h.w)!;
      expect(e.tri).toBe(d.parent[h.tri]);
      expect(Math.abs(e.weights[0] + e.weights[1] + e.weights[2] - 1)).toBeLessThan(1e-6);
      expect(e.weights.every((w) => w > -1e-6 && w < 1 + 1e-6)).toBe(true);
    }
  });

  it("gives an old vertex its own engine corner with all the weight", () => {
    const s = box();
    const d = refineSurface(s, 2);
    for (const v of [0, 5, 6]) {
      const c = drawnCorner(d, v)!;
      expect(d.indices[c.tri * 3 + c.weights.indexOf(1)]).toBe(v);
      const e = engineHit(d, c.tri, c.weights)!;
      const k = e.weights.findIndex((w) => Math.abs(w - 1) < 1e-6);
      expect(s.indices[e.tri * 3 + k]).toBe(v);
    }
    expect(drawnCorner(d, 9999)).toBeNull();
    expect(engineHit(d, d.parent.length, [1, 0, 0])).toBeNull();
    expect(engineHit(d, -1, [1, 0, 0])).toBeNull();
  });
});

describe("refineLevel", () => {
  it("picks two levels up to 12 500 triangles, one up to 50 000, none above, none for an empty result", () => {
    expect([0, 1, 12_500, 12_501, 50_000, 50_001].map((t) => refineLevel(t))).toEqual([0, 2, 2, 1, 1, 0]);
    expect(refineLevel(100, 1599)).toBe(1);
    expect(DRAWN_BUDGET).toBe(200_000);
  });
});

describe("nearestVertex", () => {
  it("is -1 with no vertices, the only one with one, and the closest of many", () => {
    expect(nearestVertex([], [1, 2, 3])).toBe(-1);
    expect(nearestVertex([13.5, -7.25, 4.1], [100, 0, 0])).toBe(0);
    const s = box();
    expect(nearestVertex(s.positions, place([19.2, 11.1, 6.6]))).toBe(6);
    expect(nearestVertex(s.positions, place([0.4, 11.5, 0.2]))).toBe(3);
  });
});

function sameZ(a: Vec3, b: Vec3): boolean {
  return Math.abs(a[2] - b[2]) > 1e-3;
}

/** The largest fold, in degrees, across the drawn edges `pick` accepts by their two endpoints (unplaced). */
function maxFoldDeg(d: DrawnSurface, pick: (a: Vec3, b: Vec3) => boolean): number {
  const T = d.indices.length / 3;
  const normal = (t: number): Vec3 => {
    const p = [0, 1, 2].map((k) => unplace(d.positions, d.indices[t * 3 + k]! * 3));
    const u = [0, 1, 2].map((c) => p[1]![c]! - p[0]![c]!);
    const v = [0, 1, 2].map((c) => p[2]![c]! - p[0]![c]!);
    const n: Vec3 = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const l = Math.hypot(...n);
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  const edges = new Map<string, number[]>();
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = d.indices[t * 3 + k]!;
      const b = d.indices[t * 3 + ((k + 1) % 3)]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, [...(edges.get(key) ?? []), t]);
    }
  }
  let worst = 0;
  for (const [key, ts] of edges) {
    if (ts.length !== 2) continue;
    const [a, b] = key.split(",").map(Number);
    if (!pick(unplace(d.positions, a! * 3), unplace(d.positions, b! * 3))) continue;
    const n0 = normal(ts[0]!);
    const n1 = normal(ts[1]!);
    const cos = Math.min(1, Math.max(-1, n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]));
    worst = Math.max(worst, (Math.acos(cos) * 180) / Math.PI);
  }
  return worst;
}
