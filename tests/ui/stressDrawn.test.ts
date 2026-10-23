import { describe, expect, it } from "vitest";
import { DRAWN_BUDGET, drawnSurface, readAt, splitDisplay, weakSpot, type DisplayMesh } from "../../src/ui/stressDrawn";
import { closestWeights, FACE_REACH, locator, type EngineSurface } from "../../src/ui/stressLocate";
import { probeValues } from "../../src/ui/stress";
import type { Vec3 } from "../../src/types";

// Every shape sits off the origin, turned 30 degrees about Z and then 20 about X, so no test leans on an axis.
const OFFSET: Vec3 = [13.5, -7.25, 4.1];
const RZ = (30 * Math.PI) / 180;
const RX = (20 * Math.PI) / 180;

function place(p: Vec3): Vec3 {
  const x1 = p[0] * Math.cos(RZ) - p[1] * Math.sin(RZ);
  const y1 = p[0] * Math.sin(RZ) + p[1] * Math.cos(RZ);
  const y2 = y1 * Math.cos(RX) - p[2] * Math.sin(RX);
  const z2 = y1 * Math.sin(RX) + p[2] * Math.cos(RX);
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

const SIZE: Vec3 = [74, 30, 18];

/** A box of SIZE with each side an n x n grid of triangle pairs and its own face (0..5), outward wound. Shared
 *  vertices make the engine's indexed boundary, unshared ones the display mesh's per face vertices. */
function gridBox(n: number, shared: boolean) {
  const pos: number[] = [];
  const idx: number[] = [];
  const faces: number[] = [];
  const ids = new Map<string, number>();
  const vertex = (p: Vec3) => {
    const key = p.map((x) => x.toFixed(6)).join(",");
    if (shared && ids.has(key)) return ids.get(key)!;
    const id = pos.length / 3;
    pos.push(...place(p));
    if (shared) ids.set(key, id);
    return id;
  };
  const sides: [number, number, number, number][] = [
    [0, 1, 2, 0],
    [0, 2, 1, 1],
    [1, 2, 0, 0],
    [1, 0, 2, 1],
    [2, 0, 1, 0],
    [2, 1, 0, 1],
  ];
  sides.forEach(([axis, u, v, high], f) => {
    const flip = (axis === 1 ? 1 - high : high) === 1;
    const cornerOf = (i: number, j: number): Vec3 => {
      const p: Vec3 = [0, 0, 0];
      p[axis] = high ? SIZE[axis]! : 0;
      p[u] = (SIZE[u]! * i) / n;
      p[v] = (SIZE[v]! * j) / n;
      return p;
    };
    const grid: number[][] = [];
    for (let i = 0; i <= n; i++) grid.push(Array.from({ length: n + 1 }, (_, j) => vertex(cornerOf(i, j))));
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const [a, b, c, d] = [grid[i]![j]!, grid[i + 1]![j]!, grid[i + 1]![j + 1]!, grid[i]![j + 1]!];
        const quad = flip ? [a, d, c, a, c, b] : [a, b, c, a, c, d];
        idx.push(...quad);
        faces.push(f, f);
      }
  });
  return { pos, idx, faces };
}

const field = (p: Vec3) => 3.1 * p[0] - 0.7 * p[1] + 2.3 * p[2] + 40;
const moveOf = (p: Vec3): Vec3 => [0.01 * p[1] + 0.2, -0.003 * p[0], 0.002 * p[2] - 0.05];

function engineBox(n = 37): EngineSurface {
  const { pos, idx, faces } = gridBox(n, true);
  const vonMises: number[] = [];
  const displacement: number[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    const p = unplace(pos, i);
    vonMises.push(field(p));
    displacement.push(...moveOf(p));
  }
  return { positions: pos, indices: idx, faceIds: faces, vonMises, displacement };
}

function displayBox(n = 1, faceStart = 9): DisplayMesh {
  const { pos, idx, faces } = gridBox(n, false);
  return {
    positions: new Float32Array(pos),
    indices: new Uint32Array(idx),
    faceIds: new Int32Array(faces.map((f) => f + faceStart)),
    faceStart,
  };
}

const vertexOf = (p: ArrayLike<number>, v: number): Vec3 => [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const WIDE = { min: -1e9, max: 1e9 };

describe("closestWeights", () => {
  const [a, b, c]: [Vec3, Vec3, Vec3] = [place([0, 0, 0]), place([8, 0, 0]), place([0, 6, 0])];
  it("reads inside, on an edge and at a corner", () => {
    const inside = closestWeights(place([2, 1.5, 4]), a, b, c);
    expect(inside.map((w) => +w.toFixed(9))).toEqual([0.5, 0.25, 0.25]);
    expect(closestWeights(place([4, -3, 1]), a, b, c).map((w) => +w.toFixed(9))).toEqual([0.5, 0.5, 0]);
    expect(closestWeights(place([-2, -2, 3]), a, b, c)).toEqual([1, 0, 0]);
    expect(closestWeights(place([0, 9, -1]), a, b, c)).toEqual([0, 0, 1]);
  });
});

describe("locator", () => {
  it("prefers a triangle of the asked face to a closer one of another face, within reach", () => {
    const s = engineBox(12);
    const at = locator(s);
    // On face 0 (x = 0) a tenth of a mm from the y = 0 edge, a hair off the surface towards face 2.
    const p = place([0.1, 0.02, 9.3]);
    const any = at.closest(p, -1)!;
    expect(s.faceIds![any.tri]).toBe(2);
    const own = at.closest(p, 0)!;
    expect(s.faceIds![own.tri]).toBe(0);
    expect(own.distance).toBeCloseTo(0.1, 9);
  });

  it("falls back to every face when the asked face is beyond reach, and keeps it exactly at the reach", () => {
    const s = engineBox();
    const at = locator(s);
    // On the top (face 5) at r from the edge it shares with face 2, so face 2 lies exactly r away.
    const reach = FACE_REACH * at.edgeAt(place([30, 4, 18]));
    const onTop = (r: number) => s.faceIds![at.closest(place([30.3, r, 18]), 2)!.tri];
    expect(onTop(reach * (1 - 1e-6))).toBe(2);
    expect(onTop(reach * (1 + 1e-6))).toBe(5);
    expect(s.faceIds![at.closest(place([30.3, 4, 18.5]), 4)!.tri]).toBe(5);
    expect(s.faceIds![at.closest(place([30.3, 4, 18.5]), -1)!.tri]).toBe(5);
  });

  it("answers null for no triangles and reads one and many", () => {
    expect(locator({ positions: [], indices: [], vonMises: [] }).closest([1, 2, 3], -1)).toBeNull();
    expect(locator({ positions: [], indices: [], vonMises: [] }).edgeAt([1, 2, 3])).toBe(0);
    const one = locator({
      positions: [...place([0, 0, 0]), ...place([6, 0, 0]), ...place([0, 3, 0])],
      indices: [0, 1, 2],
      vonMises: [1, 2, 3],
    });
    const hit = one.closest(place([1, 1, 5]), -1)!;
    expect(hit.tri).toBe(0);
    expect(hit.distance).toBeCloseTo(5, 9);
    expect(one.edgeAt(place([1, 1, 0]))).toBeCloseTo((6 + 3 + Math.hypot(6, 3)) / 3, 9);
  });

  it("keeps two locators apart", () => {
    const a = locator(engineBox(4));
    const b = locator(engineBox(8));
    const p = place([20, 10, 18]);
    expect(a.edgeAt(p)).not.toBeCloseTo(b.edgeAt(p), 3);
    expect(a.edgeAt(p)).toBeCloseTo(locator(engineBox(4)).edgeAt(p), 12);
  });
});

describe("splitDisplay", () => {
  const s = engineBox();
  const at = locator(s);

  it("splits a coarse box until every edge is no longer than the solver's edge near it", () => {
    const m = splitDisplay(displayBox(), (p) => at.edgeAt(p));
    const tris = m.indices.length / 3;
    expect(tris).toBeGreaterThan(1000);
    for (let t = 0; t < tris; t++)
      for (let k = 0; k < 3; k++) {
        const a = vertexOf(m.positions, m.indices[t * 3 + k]!);
        const b = vertexOf(m.positions, m.indices[t * 3 + ((k + 1) % 3)]!);
        const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        // On a box edge the closest engine triangle is a tie between two faces of different edge lengths.
        const local = unplace(mid, 0);
        const onEdge = local.filter((x, j) => Math.abs(x) < 1e-3 || Math.abs(x - SIZE[j]!) < 1e-3).length > 1;
        expect(dist(a, b)).toBeLessThanOrEqual(onEdge ? 2.5 : at.edgeAt(mid) * (1 + 1e-6));
      }
    // Every point stays on its side's plane, and the face ids stay global.
    const axisOf = [0, 0, 1, 1, 2, 2];
    for (let t = 0; t < tris; t++) {
      const f = m.faceIds[t]! - 9;
      for (let k = 0; k < 3; k++) {
        const p = unplace(m.positions, m.indices[t * 3 + k]! * 3);
        const want = f % 2 ? SIZE[axisOf[f]!]! : 0;
        expect(Math.abs(p[axisOf[f]!]! - want)).toBeLessThan(1e-4);
      }
    }
    expect(new Set(m.faceIds)).toEqual(new Set([9, 10, 11, 12, 13, 14]));
    expect(m.faceStart).toBe(9);
  });

  it("splits a B-rep edge at the same points from both faces", () => {
    const m = splitDisplay(displayBox(), (p) => at.edgeAt(p));
    const onEdge = new Map<string, Set<number>>();
    const faceOf = new Int32Array(m.positions.length / 3);
    for (let t = 0; t < m.indices.length / 3; t++)
      for (let k = 0; k < 3; k++) faceOf[m.indices[t * 3 + k]!] = m.faceIds[t]!;
    for (let v = 0; v < m.positions.length / 3; v++) {
      const p = unplace(m.positions, v * 3);
      const bounds = p.filter((x, k) => Math.abs(x) < 1e-4 || Math.abs(x - SIZE[k]!) < 1e-4).length;
      if (bounds < 2) continue;
      const key = [0, 1, 2].map((k) => m.positions[v * 3 + k]!).join(",");
      if (!onEdge.has(key)) onEdge.set(key, new Set());
      onEdge.get(key)!.add(faceOf[v]!);
    }
    expect(onEdge.size).toBeGreaterThan(100);
    for (const faces of onEdge.values()) expect(faces.size).toBeGreaterThanOrEqual(2);
  });

  it("grows the targets when the count would pass the budget, and not below it", () => {
    const tiny = splitDisplay(displayBox(), () => 0.05, 20_000);
    expect(tiny.indices.length / 3).toBeLessThanOrEqual(20_000);
    expect(tiny.indices.length / 3).toBeGreaterThan(20_000 / 8);
    const roomy = splitDisplay(displayBox(), () => 4, 20_000);
    const free = splitDisplay(displayBox(), () => 4);
    expect(roomy).toEqual(free);
    expect(DRAWN_BUDGET).toBe(150_000);
  });

  it("leaves an empty mesh empty and one short triangle whole", () => {
    const empty: DisplayMesh = {
      positions: new Float32Array(),
      indices: new Uint32Array(),
      faceIds: new Int32Array(),
      faceStart: 3,
    };
    expect(splitDisplay(empty, () => 1)).toEqual(empty);
    const one: DisplayMesh = {
      positions: new Float32Array([...place([0, 0, 0]), ...place([1, 0, 0]), ...place([0, 1.2, 0])]),
      indices: new Uint32Array([0, 1, 2]),
      faceIds: new Int32Array([4]),
      faceStart: 3,
    };
    expect(splitDisplay(one, () => 2.5)).toEqual(one);
    // Edges 1, 1.2 and 1.56 against 1.1: the two long ones split, three triangles.
    expect(splitDisplay(one, () => 1.1).indices.length / 3).toBe(3);
  });
});

describe("drawnSurface", () => {
  const s = engineBox();
  const at = locator(s);
  const m = splitDisplay(displayBox(), (p) => at.edgeAt(p));

  it("reads a linear field exactly at every display vertex, its displacement too", () => {
    const d = drawnSurface(m, s, at, WIDE);
    expect(d.positions).toEqual(m.positions);
    expect(d.indices).toEqual(m.indices);
    expect(Array.from(d.faces)).toEqual(Array.from(m.faceIds, (f) => f - 9));
    for (let v = 0; v < m.positions.length / 3; v++) {
      const p = unplace(m.positions, v * 3);
      expect(d.values[v]).toBeCloseTo(field(p), 2);
      const want = moveOf(p);
      for (let j = 0; j < 3; j++) expect(d.displacement![v * 3 + j]).toBeCloseTo(want[j]!, 5);
    }
  });

  it("gives coincident vertices one displacement, so a bent edge stays closed", () => {
    const d = drawnSurface(m, s, at, WIDE);
    const by = new Map<string, string>();
    for (let v = 0; v < m.positions.length / 3; v++) {
      const key = [0, 1, 2].map((k) => Math.round(m.positions[v * 3 + k]! * 1e4)).join(",");
      const disp = [0, 1, 2].map((k) => d.displacement![v * 3 + k]).join(",");
      if (by.has(key)) expect(disp).toBe(by.get(key));
      else by.set(key, disp);
    }
  });

  it("clamps values into a range narrower than the data and leaves a wide range alone", () => {
    const narrow = { min: 60, max: 200 };
    const d = drawnSurface(m, s, at, narrow);
    const values = Array.from(d.values);
    expect(Math.min(...values)).toBe(60);
    expect(Math.max(...values)).toBe(200);
    const wide = Array.from(drawnSurface(m, s, at, WIDE).values);
    expect(Math.min(...wide)).toBeLessThan(60);
    expect(Math.max(...wide)).toBeGreaterThan(200);
  });

  it("is the engine surface itself without a display mesh", () => {
    const small = engineBox(3);
    const d = drawnSurface(null, small, locator(small), { min: 50, max: 1e9 });
    expect(d).toEqual({
      positions: Float32Array.from(small.positions),
      indices: Uint32Array.from(small.indices),
      values: Float32Array.from(small.vonMises, (x) => Math.max(50, x)),
      displacement: Float32Array.from(small.displacement!),
      faces: Int32Array.from(small.faceIds!),
    });
  });

  it("hands out fresh arrays on every call", () => {
    const a = drawnSurface(m, s, at, WIDE);
    const b = drawnSurface(m, s, at, WIDE);
    expect(a.positions).not.toBe(b.positions);
    expect(a.positions).not.toBe(m.positions);
    a.values[0] = -5;
    expect(b.values[0]).not.toBe(-5);
  });
});

describe("von Mises from the stress tensor", () => {
  // Uniaxial along a slanted unit axis, changing sign along a slanted line: von Mises is |sigma|, a V across it.
  const axis: Vec3 = [0.48, -0.6, 0.64];
  const sigma = (p: Vec3) => 3.1 * (p[0] - 30.37) + 0.4 * p[2];
  const tensorBox = (n: number, withStress: boolean): EngineSurface => {
    const e = engineBox(n);
    const stress: number[] = [];
    const vonMises: number[] = [];
    const [a, b, c] = axis;
    for (let i = 0; i < e.positions.length; i += 3) {
      const t = sigma(unplace(e.positions, i));
      stress.push(t * a * a, t * b * b, t * c * c, t * a * b, t * b * c, t * c * a);
      vonMises.push(Math.abs(t));
    }
    return { ...e, vonMises, ...(withStress ? { stress } : {}) };
  };
  const errors = (withStress: boolean) => {
    const e = tensorBox(9, withStress);
    const at = locator(e);
    const m = splitDisplay(displayBox(4), () => 0.9);
    const d = drawnSurface(m, e, at, WIDE);
    return Array.from(d.values, (v, i) => Math.abs(v - Math.abs(sigma(unplace(m.positions, i * 3)))));
  };

  it("reads the V of a sign change exactly at every display vertex", () => {
    expect(Math.max(...errors(true))).toBeLessThan(1e-4);
  });

  it("dents the V when an older engine sends only the corner values", () => {
    expect(Math.max(...errors(false))).toBeGreaterThan(0.5);
  });

  it("reads the same in a probe, and falls back to the values when the tensor's length is wrong", () => {
    const e = tensorBox(9, true);
    const at = locator(e);
    const p = place([28.05, 11.3, 18]);
    const hit = at.closest(p, 5)!;
    expect(probeValues(e, hit.tri, hit.weights)!.vonMises).toBeCloseTo(Math.abs(sigma(unplace(p, 0))), 6);
    const short = { ...e, stress: Array.from(e.stress!).slice(6) };
    let blend = 0;
    for (let k = 0; k < 3; k++) blend += hit.weights[k]! * e.vonMises[e.indices[hit.tri * 3 + k]!]!;
    expect(probeValues(short, hit.tri, hit.weights)!.vonMises).toBeCloseTo(blend, 9);
    expect(blend - Math.abs(sigma(unplace(p, 0)))).toBeGreaterThan(0.5);
  });
});

describe("readAt and weakSpot", () => {
  const s = engineBox(12);
  const at = locator(s);
  const d = drawnSurface(
    splitDisplay(displayBox(), (p) => at.edgeAt(p)),
    s,
    at,
    WIDE,
  );

  it("reads the engine under the hit's rest point, the same after the surface is bent", () => {
    const tri = 17;
    const w: Vec3 = [0.2, 0.5, 0.3];
    const hit = readAt(d, at, tri, w)!;
    const rest: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++)
      for (let j = 0; j < 3; j++) rest[j] = rest[j]! + w[k]! * d.positions[d.indices[tri * 3 + k]! * 3 + j]!;
    const v = probeValues(s, hit.tri, hit.weights)!;
    expect(v.vonMises).toBeCloseTo(field(unplace(rest, 0)), 2);
    expect(s.faceIds![hit.tri]).toBe(d.faces[tri]);
    expect(readAt(d, at, -1, w)).toBeNull();
  });

  it("puts the Weakest pin on the named face although another face is closer", () => {
    // Just outside the x = 0 side near the y = 0 edge, so face 2 is nearer than face 0.
    const peak = place([-0.01, 0.3, 9]);
    const named = weakSpot(d, peak, 0)!;
    expect(d.faces[named.tri]).toBe(0);
    const any = weakSpot(d, peak, null)!;
    expect(d.faces[any.tri]).toBe(0);
    const other = weakSpot(d, place([30, -0.01, 9]), 0)!;
    expect(d.faces[other.tri]).toBe(0);
    expect(d.faces[weakSpot(d, place([30, -0.01, 9]), null)!.tri]).toBe(2);
    expect(d.faces[weakSpot(d, place([30, -0.01, 9]), 99)!.tri]).toBe(2);
  });
});
