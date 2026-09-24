// The blend ghost's face-finding: given a point along a picked edge's
// polyline, which two mesh faces meet there. The polyline and the body's own
// triangulation are separate discretizations (a real gap runs 0.8-1.4mm), so
// this never assumes a polyline point IS a mesh vertex; these fixtures build
// their meshes fine enough that resampled edge points never land on one
// either, on purpose.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { edgeFaceSamples, facesAtPoint, resampleEdge } from "../../src/viewport/ghosts";
import { BodyEdges, type BodyMesh, type ModelView } from "../../src/viewport/render";
import type { Pt3 } from "../../src/features/blendGhost";

function makeBody(id: string, positions: number[], indices: number[], faceIds: number[]): BodyMesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
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

/** Two large planes meeting at a right-angle edge along Z (x=0, y=0), a box
 *  corner. `N` subdivisions per side keep triangles small (a few mm), so the
 *  gap between a point ON the true edge and the nearest mesh VERTEX is
 *  routinely bigger than old-code's exact-match tolerance ever allowed, while
 *  nearest-TRIANGLE distance stays ~0. faceId 0 = the x=0 plane (normal
 *  +X), faceId 1 = the y=0 plane (normal +Y). */
function buildHinge(): BodyMesh {
  const N = 4;
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
  for (let iy = 0; iy < N; iy++) {
    for (let iz = 0; iz < N; iz++) {
      const y0 = -5 + (iy * 10) / N, y1 = -5 + ((iy + 1) * 10) / N;
      const z0 = (iz * 10) / N, z1 = ((iz + 1) * 10) / N;
      const A: Pt3 = [0, y0, z0], B: Pt3 = [0, y1, z0], C: Pt3 = [0, y1, z1], D: Pt3 = [0, y0, z1];
      tri(A, B, C, 0);
      tri(A, C, D, 0);
    }
  }
  for (let ix = 0; ix < N; ix++) {
    for (let iz = 0; iz < N; iz++) {
      const x0 = -5 + (ix * 10) / N, x1 = -5 + ((ix + 1) * 10) / N;
      const z0 = (iz * 10) / N, z1 = ((iz + 1) * 10) / N;
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
    const samples = edgeFaceSamples(model, { body: "hinge", points });
    expect(samples).not.toBeNull();
    expect(samples!.length).toBe(12); // sampleCount(2 raw points) floors at 12

    for (const s of samples!) {
      expect(s.point[2]).toBeGreaterThan(0);
      expect(s.point[2]).toBeLessThan(10);
    }
    // normal1 pinned to the SAME physical face throughout (never a mix, which
    // would twist the ribbon sweepBlendGhost lofts between samples).
    const xLike = samples!.every((s) => Math.abs(s.normal1[0] - 1) < 1e-6);
    const yLike = samples!.every((s) => Math.abs(s.normal1[1] - 1) < 1e-6);
    expect(xLike || yLike).toBe(true);
    for (const s of samples!) expect(Math.abs(s.tangent[2])).toBeCloseTo(1, 5);
  });

  it("skips a sample it can't resolve rather than voiding the whole edge", () => {
    const body = buildHinge();
    const model = modelOf(body);
    // Mostly the real edge, with a detour far outside both planes' tolerance
    // in the middle: some resampled points land in the detour and fail, most
    // don't.
    const points: Pt3[] = [[0, 0, 0], [0, 0, 4], [20, 0, 5], [0, 0, 6], [0, 0, 10]];
    const samples = edgeFaceSamples(model, { body: "hinge", points });
    expect(samples).not.toBeNull();
    expect(samples!.length).toBeGreaterThanOrEqual(4);
    expect(samples!.length).toBeLessThan(12);
    const xLike = samples!.every((s) => Math.abs(s.normal1[0] - 1) < 1e-6);
    const yLike = samples!.every((s) => Math.abs(s.normal1[1] - 1) < 1e-6);
    expect(xLike || yLike).toBe(true);
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
    const samples = edgeFaceSamples(model, { body: "cyl", points });
    expect(samples).not.toBeNull();
    expect(samples!.length).toBe(24); // sampleCount caps at 24 for a long polyline

    // Every sample's two faces are the lateral wall and the top cap: one
    // normal is flat (z=0, radial), the other is straight up (z=1).
    for (const s of samples!) {
      const zs = [s.normal1[2], s.normal2[2]].sort((a, b) => a - b);
      expect(zs[0]).toBeCloseTo(0, 1);
      expect(zs[1]).toBeCloseTo(1, 1);
    }
    // Pinned throughout: normal1 reads as the cap on every sample, or the
    // lateral wall on every sample, never swapping mid-loop.
    const n1IsCap = samples!.every((s) => Math.abs(s.normal1[2] - 1) < 0.2);
    const n1IsLateral = samples!.every((s) => Math.abs(s.normal1[2]) < 0.2);
    expect(n1IsCap || n1IsLateral).toBe(true);
    // Vertices sit near the rim, within a couple of triangle widths of R.
    for (const s of samples!) {
      const r = Math.hypot(s.point[0], s.point[1]);
      expect(Math.abs(r - R)).toBeLessThan(1);
    }
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

  it("returns null for a degenerate (zero-length) polyline", () => {
    const points: Pt3[] = [[1, 1, 1], [1, 1, 1]];
    expect(resampleEdge(points, 5)).toBeNull();
  });
});
