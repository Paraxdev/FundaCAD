// The blend ghost's face-finding: given a point along a picked edge's
// polyline, which two mesh faces meet there. The polyline and the body's own
// triangulation are separate discretizations (a real gap runs 0.8-1.4mm), so
// this never assumes a polyline point IS a mesh vertex; these fixtures build
// their meshes fine enough that resampled edge points never land on one
// either, on purpose.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { edgeFaceSamples, facesAtPoint, resampleEdge } from "../../src/viewport/ghosts";
import { ARC_SEGMENTS, sweepBlendGhost } from "../../src/features/blendGhost";
import { BodyEdges, type BodyMesh, type ModelView } from "../../src/viewport/render";
import type { Pt3 } from "../../src/features/blendGhost";

function makeBody(id: string, positions: number[], indices: number[], faceIds: number[], normals?: number[]): BodyMesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (normals) geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(indices), 1));
  return {
    id,
    name: id,
    faceStart: 0,
    faceCount: Math.max(...faceIds) + 1,
    mesh: new THREE.Mesh(geo),
    faceIds,
    edges: {} as BodyEdges,
    baseColors: new Float32Array(0),
    faceTriangles: new Map(),
  };
}

function modelOf(body: BodyMesh): ModelView {
  return { bodies: [body], edges: [], orphanEdges: null, box: new THREE.Box3() };
}

/** Two half planes meeting at a right-angle edge along Z, a box corner:
 *  faceId 0 is the x=0 plane over y <= 0, faceId 1 the y=0 plane over x <= 0,
 *  `height` tall. 2.5mm triangles keep the gap between a point ON the true edge
 *  and the nearest mesh VERTEX routinely bigger than an exact-match tolerance
 *  would allow, while nearest-TRIANGLE distance stays ~0. `flip` reverses every
 *  triangle's winding; `gap` leaves out the triangles between two heights. */
function buildHinge(opts: { flip?: boolean; height?: number; gap?: [number, number] } = {}): BodyMesh {
  const { flip = false, height = 10, gap } = opts;
  const N = 4;
  const NZ = Math.round(height / 2.5);
  const positions: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  let vi = 0;
  const tri = (p0: Pt3, p1: Pt3, p2: Pt3, fid: number) => {
    if (flip) positions.push(...p0, ...p2, ...p1);
    else positions.push(...p0, ...p1, ...p2);
    indices.push(vi, vi + 1, vi + 2);
    vi += 3;
    faceIds.push(fid);
  };
  const skip = (z0: number) => !!gap && z0 >= gap[0] && z0 < gap[1];
  for (let iy = 0; iy < N; iy++) {
    for (let iz = 0; iz < NZ; iz++) {
      const y0 = -10 + (iy * 10) / N, y1 = -10 + ((iy + 1) * 10) / N;
      const z0 = iz * 2.5, z1 = (iz + 1) * 2.5;
      if (skip(z0)) continue;
      const A: Pt3 = [0, y0, z0], B: Pt3 = [0, y1, z0], C: Pt3 = [0, y1, z1], D: Pt3 = [0, y0, z1];
      tri(A, B, C, 0);
      tri(A, C, D, 0);
    }
  }
  for (let ix = 0; ix < N; ix++) {
    for (let iz = 0; iz < NZ; iz++) {
      const x0 = -10 + (ix * 10) / N, x1 = -10 + ((ix + 1) * 10) / N;
      const z0 = iz * 2.5, z1 = (iz + 1) * 2.5;
      if (skip(z0)) continue;
      const A: Pt3 = [x0, 0, z0], B: Pt3 = [x0, 0, z1], C: Pt3 = [x1, 0, z1], D: Pt3 = [x1, 0, z0];
      tri(A, B, C, 1);
      tri(A, C, D, 1);
    }
  }
  return makeBody("hinge", positions, indices, faceIds);
}

const LATERAL = 100;
const CAP = 101;

/** A cylinder rim: `N` lateral quads (radial outward normal) meeting an `N`-
 *  triangle top cap fan (normal +Z) at radius `R`, height `H`. */
function buildCylinder(N: number, R: number, H: number): BodyMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  let vi = 0;
  const tri = (p0: Pt3, p1: Pt3, p2: Pt3, fid: number) => {
    positions.push(...p0, ...p1, ...p2);
    indices.push(vi, vi + 1, vi + 2);
    vi += 3;
    faceIds.push(fid);
  };
  for (let k = 0; k < N; k++) {
    const a0 = (2 * Math.PI * k) / N, a1 = (2 * Math.PI * (k + 1)) / N;
    const A: Pt3 = [R * Math.cos(a0), R * Math.sin(a0), 0];
    const B: Pt3 = [R * Math.cos(a1), R * Math.sin(a1), 0];
    const C: Pt3 = [R * Math.cos(a1), R * Math.sin(a1), H];
    const D: Pt3 = [R * Math.cos(a0), R * Math.sin(a0), H];
    tri(A, B, C, LATERAL);
    tri(A, C, D, LATERAL);
  }
  const center: Pt3 = [0, 0, H];
  for (let k = 0; k < N; k++) {
    const a0 = (2 * Math.PI * k) / N, a1 = (2 * Math.PI * (k + 1)) / N;
    const p0: Pt3 = [R * Math.cos(a0), R * Math.sin(a0), H];
    const p1: Pt3 = [R * Math.cos(a1), R * Math.sin(a1), H];
    tri(center, p0, p1, CAP);
  }
  return makeBody("cyl", positions, indices, faceIds);
}

/** The rim as a PICKED EDGE would arrive: its own polyline, sampled at a
 *  point count and phase that don't line up with the mesh's own N segments,
 *  the same way an edge's tessellation and the body's never agree in the app. */
function rimPolyline(M: number, R: number, H: number, phase: number): Pt3[] {
  const pts: Pt3[] = [];
  for (let i = 0; i <= M; i++) {
    const a = phase + (2 * Math.PI * i) / M;
    pts.push([R * Math.cos(a), R * Math.sin(a), H]);
  }
  return pts;
}

describe("facesAtPoint", () => {
  it("finds the two adjacent faces by nearest triangle, not an exact vertex match", () => {
    const body = buildHinge();
    // z=4.37 is not a grid line (the hinge's grid steps by 2.5), so no mesh
    // vertex sits here, only the true edge does.
    const found = facesAtPoint(body, [0, 0, 4.37]);
    expect(found).not.toBeNull();
    expect(new Set(found!.faceIds)).toEqual(new Set([0, 1]));
    const ns = found!.normals.map((n) => [n.x, n.y, n.z]);
    expect(ns.some((n) => Math.abs(n[0]! - 1) < 1e-6)).toBe(true);
    expect(ns.some((n) => Math.abs(n[1]! - 1) < 1e-6)).toBe(true);
  });

  it("returns null far from any triangle", () => {
    const body = buildHinge();
    expect(facesAtPoint(body, [1000, 1000, 1000])).toBeNull();
  });
});

describe("edgeFaceSamples", () => {
  it("resolves a straight edge given only its two corner endpoints (never a mesh vertex)", () => {
    const body = buildHinge();
    const model = modelOf(body);
    const points: Pt3[] = [[0, 0, 0], [0, 0, 10]];
    const found = edgeFaceSamples(model, { body: "hinge", points });
    expect(found).not.toBeNull();
    expect(found!.closed).toBe(false);
    const samples = found!.samples;
    // 12 inset samples (sampleCount floors at 12) plus the two true ends
    expect(samples.length).toBe(14);
    expect(samples[0]!.point).toEqual([0, 0, 0]);
    expect(samples[13]!.point).toEqual([0, 0, 10]);
    // face 1 pinned to the SAME physical face throughout (never a mix, which
    // would twist the ribbon sweepBlendGhost lofts between samples): the x=0
    // plane runs off along y, the y=0 plane along x.
    const onX = samples.every((s) => Math.abs(Math.abs(s.into1[1]) - 1) < 1e-6);
    const onY = samples.every((s) => Math.abs(Math.abs(s.into1[0]) - 1) < 1e-6);
    expect(onX || onY).toBe(true);
    for (const s of samples) expect(Math.abs(s.tangent[2])).toBeCloseTo(1, 5);
  });

  it("finds the same wedge whichever way the mesh's triangles wind", () => {
    const points: Pt3[] = [[0, 0, 0], [0, 0, 10]];
    const a = edgeFaceSamples(modelOf(buildHinge()), { body: "hinge", points: [...points] })!.samples;
    const b = edgeFaceSamples(modelOf(buildHinge({ flip: true })), { body: "hinge", points: [...points] })!.samples;
    const key = (s: (typeof a)[number]) =>
      [s.into1, s.into2].map((d) => d.map((x) => Math.round(x * 1e6) / 1e6 + 0).join(",")).sort().join("|");
    expect(b.map(key)).toEqual(a.map(key));
    // the hinge's planes both run off toward negative x and y
    for (const s of a) {
      for (const d of [s.into1, s.into2]) expect(d[0] + d[1]).toBeLessThan(0);
    }
  });

  it("skips a sample it can't resolve rather than voiding the whole edge", () => {
    // The mesh is missing along a stretch of the edge further than the
    // tolerance reaches: the samples there fail, the rest don't.
    const body = buildHinge({ height: 60, gap: [10, 50] });
    const model = modelOf(body);
    const points: Pt3[] = [[0, 0, 0], [0, 0, 60]];
    const found = edgeFaceSamples(model, { body: "hinge", points });
    expect(found).not.toBeNull();
    const samples = found!.samples;
    expect(samples.length).toBeGreaterThanOrEqual(4);
    expect(samples.length).toBeLessThan(14);
    expect(samples.some((s) => s.point[2] > 20 && s.point[2] < 40)).toBe(false);
    const onX = samples.every((s) => Math.abs(Math.abs(s.into1[1]) - 1) < 1e-6);
    const onY = samples.every((s) => Math.abs(Math.abs(s.into1[0]) - 1) < 1e-6);
    expect(onX || onY).toBe(true);
  });

  it("returns null when the body is missing or the edge has fewer than 2 points", () => {
    const body = buildHinge();
    const model = modelOf(body);
    const points: Pt3[] = [[0, 0, 0], [0, 0, 10]];
    expect(edgeFaceSamples(model, { body: "nope", points })).toBeNull();
    expect(edgeFaceSamples(model, { body: "hinge", points: [[0, 0, 0]] })).toBeNull();
  });

  it("resolves a cylinder rim sampled at a different phase/density than the mesh's own tessellation, without twisting", () => {
    const N = 16, R = 5, H = 10;
    const body = buildCylinder(N, R, H);
    const model = modelOf(body);
    const points = rimPolyline(40, R, H, Math.PI / N);
    const found = edgeFaceSamples(model, { body: "cyl", points });
    expect(found).not.toBeNull();
    expect(found!.closed).toBe(true);
    const samples = found!.samples;
    expect(samples.length).toBe(41); // one per polyline point, no inset on a loop

    // Every sample's two faces are the lateral wall, running down (-z), and
    // the top cap, running in toward the axis.
    for (const s of samples) {
      const zs = [s.into1[2], s.into2[2]].sort((a, b) => a - b);
      expect(zs[0]).toBeCloseTo(-1, 5);
      expect(zs[1]).toBeCloseTo(0, 5);
    }
    // Pinned throughout: face 1 is the cap on every sample or the wall on
    // every sample, never swapping mid-loop.
    const intoCap = samples.every((s) => Math.abs(s.into1[2]) < 0.2);
    const intoWall = samples.every((s) => Math.abs(s.into1[2] + 1) < 0.2);
    expect(intoCap || intoWall).toBe(true);
    for (const s of samples) {
      const r = Math.hypot(s.point[0], s.point[1]);
      expect(Math.abs(r - R)).toBeLessThan(1);
    }
  });
});

describe("blend ghost on a cylinder's circular rim", () => {
  const N = 48, R = 10, H = 10, r = 2;
  const ghost = () => {
    const body = buildCylinder(N, R, H);
    const found = edgeFaceSamples(modelOf(body), { body: "cyl", points: rimPolyline(90, R, H, 0.013) })!;
    return { found, geo: sweepBlendGhost(found.samples, r, "fillet", found.closed)! };
  };

  it("is a closed ring with no gap at the polyline's seam", () => {
    const { found, geo } = ghost();
    expect(found.closed).toBe(true);
    const n = found.samples.length;
    expect(geo.positions.length).toBe(n * ARC_SEGMENTS * 6 * 3);
    // the last strip closes onto the very first cross-section
    const b0 = geo.positions.length - (ARC_SEGMENTS * 6 - 5) * 3;
    const gap = Math.hypot(...[0, 1, 2].map((k) => geo.positions[b0 + k]! - geo.positions[k]!));
    expect(gap).toBeLessThan(1e-9);
  });

  it("is a quarter torus of the dragged radius about the rim", () => {
    const { geo } = ghost();
    // every vertex r from the fillet's spine circle (radius R - r at height H - r)
    for (let i = 0; i < geo.positions.length; i += 3) {
      const rho = Math.hypot(geo.positions[i]!, geo.positions[i + 1]!);
      const z = geo.positions[i + 2]!;
      expect(Math.abs(Math.hypot(rho - (R - r), z - (H - r)) - r)).toBeLessThan(0.05);
      expect(rho).toBeLessThanOrEqual(R + 1e-6);
      expect(z).toBeLessThanOrEqual(H + 1e-6);
    }
  });

  it("sits on the rim: it meets the cap r in from the edge and the wall r down", () => {
    const { geo } = ghost();
    let onCap = 0, onWall = 0;
    for (let i = 0; i < geo.positions.length; i += 3) {
      const rho = Math.hypot(geo.positions[i]!, geo.positions[i + 1]!);
      const z = geo.positions[i + 2]!;
      if (Math.abs(z - H) < 1e-6 && Math.abs(rho - (R - r)) < 0.05) onCap++;
      if (Math.abs(rho - R) < 0.05 && Math.abs(z - (H - r)) < 1e-6) onWall++;
    }
    expect(onCap).toBeGreaterThan(0);
    expect(onWall).toBeGreaterThan(0);
    expect(onCap).toBe(onWall);
  });
});

/** A closed D-shaft prism with shipped surface normals: a cylinder of radius
 *  `R` about Z cut flat at x = `a`, `H` tall. The flat meets the round along
 *  the straight edge at (a, sqrt(R^2 - a^2)). */
function buildDShaft(R: number, a: number, H: number, N: number): BodyMesh {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [], faceIds: number[] = [];
  const tri = (p: Pt3[], n: Pt3[], fid: number) => {
    for (let k = 0; k < 3; k++) {
      indices.push(positions.length / 3);
      positions.push(...p[k]!);
      normals.push(...n[k]!);
    }
    faceIds.push(fid);
  };
  const t0 = Math.acos(a / R);
  const ring: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const t = t0 + ((2 * Math.PI - 2 * t0) * i) / N;
    ring.push([R * Math.cos(t), R * Math.sin(t)]);
  }
  for (let i = 0; i < N; i++) {
    const [x0, y0] = ring[i]!, [x1, y1] = ring[i + 1]!;
    const n0: Pt3 = [x0 / R, y0 / R, 0], n1: Pt3 = [x1 / R, y1 / R, 0];
    tri([[x0, y0, 0], [x1, y1, 0], [x1, y1, H]], [n0, n1, n1], 1);
    tri([[x0, y0, 0], [x1, y1, H], [x0, y0, H]], [n0, n1, n0], 1);
    tri([[0, 0, 0], [x1, y1, 0], [x0, y0, 0]], [[0, 0, -1], [0, 0, -1], [0, 0, -1]], 2);
    tri([[0, 0, H], [x0, y0, H], [x1, y1, H]], [[0, 0, 1], [0, 0, 1], [0, 0, 1]], 3);
  }
  const [xe, ye] = ring[0]!, [xs, ys] = ring[N]!;
  const fx: Pt3 = [1, 0, 0];
  for (let j = 0; j < 8; j++) {
    const y0 = ys + ((ye - ys) * j) / 8, y1 = ys + ((ye - ys) * (j + 1)) / 8;
    tri([[a, y0, 0], [a, y1, 0], [a, y1, H]], [fx, fx, fx], 0);
    tri([[a, y0, 0], [a, y1, H], [a, y0, H]], [fx, fx, fx], 0);
  }
  tri([[0, 0, 0], [xe, ye, 0], [xs, ys, 0]], [[0, 0, -1], [0, 0, -1], [0, 0, -1]], 2);
  tri([[0, 0, H], [xs, ys, H], [xe, ye, H]], [[0, 0, 1], [0, 0, 1], [0, 0, 1]], 3);
  return makeBody("d", positions, indices, faceIds, normals);
}

describe("blend ghost against a curved face, read off the mesh", () => {
  const R = 10, a = 6, H = 20;
  const ye = Math.sqrt(R * R - a * a);
  const found = () => edgeFaceSamples(modelOf(buildDShaft(R, a, H, 72)), { body: "d", points: [[a, ye, 0], [a, ye, H]] })!;

  it("measures the round's curvature from the shipped normals", () => {
    const s = found().samples[5]!;
    const bends = [s.bend1 ?? 0, s.bend2 ?? 0].sort((x, y) => x - y);
    expect(bends[0]).toBeCloseTo(0, 6);
    expect(bends[1]! * R).toBeCloseTo(1, 2);
  });

  // The ball inside the D, touching the flat (centre a - r off it) and the
  // round from inside (centre R - r from the axis).
  for (const r of [2, 6, 7.5]) {
    it(`rolls the ball against the round at r = ${r}, r/R = ${r / R}`, () => {
      const { samples } = found();
      const geo = sweepBlendGhost(samples, r, "fillet")!;
      expect(geo.unsure).toBe(false);
      const c = [a - r, Math.sqrt((R - r) ** 2 - (a - r) ** 2)];
      for (let i = 0; i < geo.positions.length; i += 3) {
        const d = Math.hypot(geo.positions[i]! - c[0]!, geo.positions[i + 1]! - c[1]!);
        expect(Math.abs(d - r)).toBeLessThan(0.03 * r);
      }
    });
  }

  it("fades when no ball of that size can sit on the round", () => {
    // r = 9: a ball that far off the flat would stick out of the D.
    const geo = sweepBlendGhost(found().samples, 9, "fillet");
    expect(geo?.unsure).toBe(true);
  });
});

describe("resampleEdge", () => {
  it("insets from both ends and spaces points evenly by arc length", () => {
    const points: Pt3[] = [[0, 0, 0], [0, 0, 10]];
    const pts = resampleEdge(points, 5);
    expect(pts).not.toBeNull();
    expect(pts!.length).toBe(5);
    expect(pts![0]![2]).toBeGreaterThan(0);
    expect(pts![pts!.length - 1]![2]).toBeLessThan(10);
    const steps = pts!.slice(1).map((p, i) => p[2] - pts![i]![2]);
    for (const s of steps) expect(s).toBeCloseTo(steps[0]!, 6);
  });

  it("walks a closed loop all the way round without repeating its start", () => {
    const loop: Pt3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 0]];
    const pts = resampleEdge(loop, 8, true)!;
    expect(pts.length).toBe(8);
    expect(pts[0]).toEqual([0, 0, 0]);
    expect(pts[7]).toEqual([0, 5, 0]);
  });

  it("returns null for a degenerate (zero-length) polyline", () => {
    const points: Pt3[] = [[1, 1, 1], [1, 1, 1]];
    expect(resampleEdge(points, 5)).toBeNull();
  });
});
