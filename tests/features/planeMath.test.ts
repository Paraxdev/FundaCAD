import { describe, it, expect } from "vitest";
import type { Vec3 } from "../../src/types";
import {
  axisFromEdge,
  axisFromNormals,
  cylinderFromFace,
  fitCircle2D,
  isPlanarFace,
  planeFromPickedFace,
  planeFromPointNormal,
  planeXDir,
  radialAt,
  solidInsideCylinder,
  tangentPlaneOnCylinder,
  unit,
} from "../../src/features/planeMath";

/** A tessellated cylinder of radius `r` about the +Z axis through (cx, cy),
 *  spanning z 0..h: the vertices sit exactly ON the surface (as a kernel's do)
 *  and each facet normal is the radial direction at its own middle. */
function cylinderMesh(r: number, cx = 0, cy = 0, h = 10, seg = 24, arc = Math.PI * 2) {
  const points: Vec3[] = [];
  const normals: Vec3[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (arc * i) / seg;
    const a1 = (arc * (i + 1)) / seg;
    points.push([cx + r * Math.cos(a0), cy + r * Math.sin(a0), 0]);
    points.push([cx + r * Math.cos(a1), cy + r * Math.sin(a1), h]);
    const am = (a0 + a1) / 2;
    normals.push([Math.cos(am), Math.sin(am), 0]);
  }
  return { points, normals };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("planeXDir", () => {
  it("gives an x axis that lies IN the plane", () => {
    for (const n of [[0, 0, 1], [1, 0, 0], [0.3, -0.5, 0.81]] as Vec3[]) {
      const x = planeXDir(n)!;
      expect(dot(x, unit(n)!)).toBeCloseTo(0, 10);
      expect(Math.hypot(...x)).toBeCloseTo(1, 10);
    }
  });

  it("is the one rule every face pick goes through", () => {
    // Arbitrary, but it must be THE choice: world +Z projected in, except on a
    // near-horizontal plane where +Z has nothing to project. viewport
    // .pickFacePlane carried a second copy of this and now calls through here —
    // two derivations of an arbitrary axis is a sketch that rotates about its
    // own normal depending on which route created its plane.
    expect(planeXDir([0, 0, 1])).toEqual([1, 0, 0]);
    expect(planeXDir([1, 0, 0])).toEqual([0, 0, 1]);
  });

  it("refuses a direction it cannot normalise", () => {
    expect(planeXDir([0, 0, 0])).toBeNull();
  });
});

describe("planeFromPointNormal", () => {
  it("anchors the origin at the world origin projected onto the plane", () => {
    // NOT at the clicked point: the origin sets the snap lattice, so two picks
    // on the SAME face must produce the same plane, byte for byte.
    const a = planeFromPointNormal([3, 7, 10], [0, 0, 1])!;
    const b = planeFromPointNormal([-40, 2.5, 10], [0, 0, 1])!;
    expect(a.origin).toEqual([0, 0, 10]);
    expect(a).toEqual(b);
  });

  it("keeps the normal unit and the frame orthogonal on a tilted face", () => {
    const p = planeFromPointNormal([1, 2, 3], [2, 0, 2])!;
    expect(Math.hypot(...p.normal)).toBeCloseTo(1, 10);
    expect(dot(p.normal, p.xdir)).toBeCloseTo(0, 10);
    // the origin is on the plane through the given point
    expect(dot(p.normal, p.origin)).toBeCloseTo(dot(p.normal, [1, 2, 3]), 10);
  });
});

describe("isPlanarFace", () => {
  it("accepts facet normals that agree and rejects a swept one", () => {
    expect(isPlanarFace([[0, 0, 1], [0, 0, 1], [0, 0, 1]])).toBe(true);
    expect(isPlanarFace(cylinderMesh(5).normals)).toBe(false);
  });

  it("tolerates the numerical noise a real tessellation carries", () => {
    expect(isPlanarFace([[0, 0, 1], [1e-6, -2e-6, 1]])).toBe(true);
  });
});

describe("axisFromNormals", () => {
  it("recovers the axis of a cylinder from its facet normals", () => {
    const axis = axisFromNormals(cylinderMesh(5).normals)!;
    expect(Math.abs(dot(axis, [0, 0, 1]))).toBeCloseTo(1, 6);
  });

  it("still recovers it from a HALF cylinder, where the crosses cancel unsigned", () => {
    // Sweeping past 180° puts pairs on both sides of the seed; folding them in
    // without the sign flip averages the axis to zero.
    const axis = axisFromNormals(cylinderMesh(5, 0, 0, 10, 24, Math.PI * 1.6).normals)!;
    expect(Math.abs(dot(axis, [0, 0, 1]))).toBeCloseTo(1, 6);
  });

  it("has no axis for a flat face", () => {
    expect(axisFromNormals([[0, 0, 1], [0, 0, 1]])).toBeNull();
  });
});

describe("fitCircle2D", () => {
  it("fits a circle through points that lie on one", () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      pts.push([4 + 3 * Math.cos(a), -2 + 3 * Math.sin(a)]);
    }
    const f = fitCircle2D(pts)!;
    expect(f.cx).toBeCloseTo(4, 8);
    expect(f.cy).toBeCloseTo(-2, 8);
    expect(f.r).toBeCloseTo(3, 8);
    expect(f.rms).toBeLessThan(1e-8);
  });

  it("refuses collinear points instead of returning a centre at infinity", () => {
    expect(fitCircle2D([[0, 0], [1, 0], [2, 0], [3, 0]])).toBeNull();
    expect(fitCircle2D([[0, 0], [1, 1]])).toBeNull();
  });
});

describe("cylinderFromFace", () => {
  it("recovers axis, centre and radius from a tessellated cylinder", () => {
    const { points, normals } = cylinderMesh(7, 12, -5);
    const cyl = cylinderFromFace(points, normals)!;
    expect(cyl.radius).toBeCloseTo(7, 6);
    expect(Math.abs(dot(cyl.axis, [0, 0, 1]))).toBeCloseTo(1, 6);
    // the recovered point is ON the axis: its x/y match the true centre
    expect(cyl.point[0]).toBeCloseTo(12, 6);
    expect(cyl.point[1]).toBeCloseTo(-5, 6);
  });

  it("recovers the TRUE radius, not the chord radius", () => {
    // A coarse tessellation's facet centres sit a sagitta inside the surface;
    // fitting those instead of the vertices is what would sink a tangent plane
    // into the material.
    const { points, normals } = cylinderMesh(10, 0, 0, 5, 8);
    expect(cylinderFromFace(points, normals)!.radius).toBeCloseTo(10, 6);
  });

  it("refuses a sphere, which has an axis-ish direction but no single circle", () => {
    const points: Vec3[] = [];
    const normals: Vec3[] = [];
    for (let i = 1; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        const th = (i / 8) * Math.PI;
        const ph = (j / 8) * Math.PI * 2;
        const n: Vec3 = [
          Math.sin(th) * Math.cos(ph),
          Math.sin(th) * Math.sin(ph),
          Math.cos(th),
        ];
        normals.push(n);
        points.push([n[0] * 6, n[1] * 6, n[2] * 6]);
      }
    }
    expect(cylinderFromFace(points, normals)).toBeNull();
  });
});

/** A cylinder wall as TRIANGLES — three corners per facet, which is the packing
 *  facePlanePick collects and the only one solidInsideCylinder accepts.
 *  `bore` flips the normals inward, as a hole's are. */
function cylinderTris(r: number, bore = false, seg = 16, h = 10, arc = Math.PI * 2) {
  const points: Vec3[] = [];
  const normals: Vec3[] = [];
  const s = bore ? -1 : 1;
  for (let i = 0; i < seg; i++) {
    const a0 = (arc * i) / seg;
    const a1 = (arc * (i + 1)) / seg;
    points.push(
      [r * Math.cos(a0), r * Math.sin(a0), 0],
      [r * Math.cos(a1), r * Math.sin(a1), 0],
      [r * Math.cos(a1), r * Math.sin(a1), h],
    );
    const am = (a0 + a1) / 2;
    normals.push([s * Math.cos(am), s * Math.sin(am), 0]);
  }
  return { points, normals };
}

describe("solidInsideCylinder", () => {
  const cyl = { axis: [0, 0, 1] as Vec3, point: [0, 0, 0] as Vec3, radius: 5 };

  it("tells a shaft from a bore", () => {
    const boss = cylinderTris(5);
    const bore = cylinderTris(5, true);
    expect(solidInsideCylinder(cyl, boss.points, boss.normals)).toBe(true);
    expect(solidInsideCylinder(cyl, bore.points, bore.normals)).toBe(false);
  });

  it("survives a CLOSED cylinder, where the average normal is zero", () => {
    // The whole point. faceNormalWorld sums the facet normals and a full
    // cylinder's cancel to (0,0,0), which is how a round face's drag handle
    // ended up pointing at world +Z. Per-facet against its own radial has
    // nothing to cancel.
    const { points, normals } = cylinderTris(5, false, 64);
    const sum = normals.reduce((a, n) => [a[0] + n[0], a[1] + n[1], a[2] + n[2]] as Vec3, [0, 0, 0] as Vec3);
    expect(Math.hypot(...sum)).toBeLessThan(1e-9); // the degeneracy, reproduced
    expect(solidInsideCylinder(cyl, points, normals)).toBe(true);
  });

  it("answers a half cylinder the same as a whole one", () => {
    const half = cylinderTris(5, false, 16, 10, Math.PI);
    expect(solidInsideCylinder(cyl, half.points, half.normals)).toBe(true);
    const halfBore = cylinderTris(5, true, 16, 10, Math.PI);
    expect(solidInsideCylinder(cyl, halfBore.points, halfBore.normals)).toBe(false);
  });

  it("refuses the wrong point packing rather than reading it loosely", () => {
    // One point per normal indexes into the wrong facet and still answers — and
    // the answer is a sign, so a plausible one is worse than none.
    const { points, normals } = cylinderTris(5);
    expect(solidInsideCylinder(cyl, points.slice(0, normals.length), normals)).toBeNull();
  });

  it("has no opinion about a flat face that happens to be handed to it", () => {
    const points: Vec3[] = [[0, 0, 9], [1, 0, 9], [0, 1, 9]];
    expect(solidInsideCylinder(cyl, points, [[0, 0, 1]])).toBeNull(); // all grazing
  });
});

describe("radialAt", () => {
  const cyl = { axis: [0, 0, 1] as Vec3, point: [0, 0, 0] as Vec3, radius: 5 };

  it("points away from the axis, whatever the height", () => {
    expect(radialAt(cyl, [4.9, 0, 3])).toEqual([1, 0, 0]);
    expect(radialAt(cyl, [0, -2, -8])).toEqual([0, -1, 0]);
  });

  it("is null on the axis, where outward means nothing", () => {
    expect(radialAt(cyl, [0, 0, 4])).toBeNull();
  });
});

describe("tangentPlaneOnCylinder", () => {
  const cyl = { axis: [0, 0, 1] as Vec3, point: [0, 0, 0] as Vec3, radius: 5 };

  it("touches the surface even when the picked point is inside it", () => {
    // the raycast hits a chord, a sagitta short of the true surface
    const p = tangentPlaneOnCylinder(cyl, [4.9, 0, 3])!;
    expect(p.origin).toEqual([5, 0, 3]);
    expect(p.normal).toEqual([1, 0, 0]);
  });

  it("runs its x axis along the shaft", () => {
    expect(tangentPlaneOnCylinder(cyl, [0, 5, 1])!.xdir).toEqual([0, 0, 1]);
  });

  it("faces into the bore on a hole, following the face's own normal", () => {
    // A hole wall's normal points at the axis. The plane must agree — otherwise
    // its offset runs backwards — while still SITTING on the surface.
    const p = tangentPlaneOnCylinder(cyl, [5, 0, 0], [-1, 0, 0])!;
    expect(p.origin).toEqual([5, 0, 0]);
    expect(p.normal[0]).toBeCloseTo(-1, 10);
    expect(p.normal[1]).toBeCloseTo(0, 10);
  });

  it("has no answer on the axis itself", () => {
    expect(tangentPlaneOnCylinder(cyl, [0, 0, 4])).toBeNull();
  });
});

describe("planeFromPickedFace", () => {
  it("takes a flat face at its own plane", () => {
    const r = planeFromPickedFace(
      [[0, 0, 4], [10, 0, 4], [10, 10, 4]],
      [[0, 0, 1], [0, 0, 1], [0, 0, 1]],
      [3, 3, 4],
      [0, 0, 1],
    )!;
    expect(r.kind).toBe("planar");
    expect(r.def.origin).toEqual([0, 0, 4]);
  });

  it("takes a round face at the tangent plane under the cursor", () => {
    const { points, normals } = cylinderMesh(5);
    const r = planeFromPickedFace(points, normals, [0, 5, 2], [0, 1, 0])!;
    expect(r.kind).toBe("tangent");
    expect(r.def.normal[1]).toBeCloseTo(1, 6);
    expect(r.def.origin[1]).toBeCloseTo(5, 6);
  });

  it("declines a face it can recognise as neither", () => {
    // a spline-ish scatter: not flat, not one cylinder — better no datum than a
    // plane through a surface that has no tangent frame worth the name.
    const points: Vec3[] = [[0, 0, 0], [1, 0, 0.3], [2, 0, 1.4], [3, 0, 3.9]];
    const normals: Vec3[] = [[0, 0, 1], [0, 0.3, 1], [0, 0.9, 1], [0, 2, 1]];
    expect(planeFromPickedFace(points, normals, [1, 0, 0.3], [0, 0.3, 1])).toBeNull();
  });
});

describe("axisFromEdge", () => {
  const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

  it("reads the line off a two-point edge", () => {
    const ax = axisFromEdge([[1, 2, 3], [1, 2, 9]]);
    expect(ax).not.toBeNull();
    near(ax!.origin[2], 3);
    near(ax!.dir[2], 1);
    near(ax!.dir[0], 0);
  });

  it("accepts a straight edge tessellated into many collinear samples", () => {
    const pts: Vec3[] = [];
    for (let i = 0; i <= 8; i++) pts.push([i, 2 * i, -i]);
    expect(axisFromEdge(pts)).not.toBeNull();
  });

  it("refuses an arc, which is not a line and cannot be an axis", () => {
    const pts: Vec3[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = (i / 12) * (Math.PI / 2);
      pts.push([Math.cos(t) * 10, Math.sin(t) * 10, 0]);
    }
    expect(axisFromEdge(pts)).toBeNull();
  });

  it("refuses a bulge far below what an arc would give but above the tolerance", () => {
    // The control for the test above: a 90° arc bulges by 0.29 of its chord, so
    // rejecting one proves nothing about where the line actually is. This bulges
    // by 1e-3 of the chord, ten times the tolerance and invisible on screen.
    expect(axisFromEdge([[0, 0, 0], [50, 0.1, 0], [100, 0, 0]])).toBeNull();
    expect(axisFromEdge([[0, 0, 0], [50, 1e-3, 0], [100, 0, 0]])).not.toBeNull();
  });

  it("has no answer for a zero-length edge or a single point", () => {
    expect(axisFromEdge([[1, 1, 1], [1, 1, 1]])).toBeNull();
    expect(axisFromEdge([[1, 1, 1]])).toBeNull();
    expect(axisFromEdge([])).toBeNull();
  });
});
