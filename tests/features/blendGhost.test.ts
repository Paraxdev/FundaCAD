// The ghost's whole value is looking like the real blend at a glance while the
// kernel is still thinking, so these check the geometry against a corner worked
// out by hand rather than against the code that produces it.

import { describe, it, expect } from "vitest";
import { ARC_SEGMENTS, sweepBlendGhost, type EdgeSample } from "../../src/features/blendGhost";

/** A right-angle corner running along Z: face 1 is the x=0 plane (extending
 *  toward -y), face 2 is the y=0 plane (extending toward -x), the same corner
 *  worked out in the module comment. `z` samples let a test move the edge
 *  point without touching the wedge. */
function cornerSample(z: number): EdgeSample {
  return { point: [0, 0, z], tangent: [0, 0, 1], normal1: [1, 0, 0], normal2: [0, 1, 0] };
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

describe("sweepBlendGhost / fillet", () => {
  it("sweeps a quarter circle between the two faces along a straight edge", () => {
    const r = 2;
    const samples = [cornerSample(0), cornerSample(10)];
    const geo = sweepBlendGhost(samples, r, "fillet");
    expect(geo).not.toBeNull();

    // ARC_SEGMENTS+1 points per cross-section, 2 cross-sections, 2 triangles
    // (6 verts) per quad strip between consecutive arc segments.
    const vertsPerStrip = 6;
    expect(geo!.positions.length).toBe(ARC_SEGMENTS * vertsPerStrip * 3);

    // The very first vertex emitted is cross-section 0's first arc point: face
    // 1's tangent point, distance r from the edge, lying ON face 1 (x=0).
    const p0 = geo!.positions.slice(0, 3);
    expect(p0[0]).toBeCloseTo(0, 6);
    expect(dist(p0, [0, 0, 0])).toBeCloseTo(r, 6);

    // The last strip's `b1` vertex (local slot 2 of its 6) is cross-section 1's
    // LAST arc point: face 2's tangent point, on y=0, distance r from the edge.
    const lastStripBase = (ARC_SEGMENTS - 1) * vertsPerStrip * 3;
    const face2Point = geo!.positions.slice(lastStripBase + 6, lastStripBase + 9);
    expect(face2Point[1]).toBeCloseTo(0, 6);
    expect(dist(face2Point, [0, 0, 10])).toBeCloseTo(r, 6); // cross-section 1 is at z=10

    // Every arc point sits exactly radius r from the circle's own center
    // (-r, -r, 0), the worked example in the module comment.
    const center = [-r, -r, 0];
    for (let i = 0; i < geo!.positions.length; i += 3) {
      const p = geo!.positions.slice(i, i + 3);
      if (p[2] !== 0) continue; // only check cross-section z=0 verts here
      expect(dist(p, center)).toBeCloseTo(r, 5);
    }
  });

  it("bends the arc sample by sample around a circular edge, not just at the ends", () => {
    // A hole's rim: the edge runs around a circle of radius 5 in the XY plane,
    // the planar face's normal is a fixed +Z, the cylindrical face's normal is
    // radial and turns WITH the edge.
    const R = 5;
    const n = 12;
    const samples: EdgeSample[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (2 * Math.PI * i) / n;
      const c = Math.cos(a), s = Math.sin(a);
      samples.push({
        point: [R * c, R * s, 0],
        tangent: [-s, c, 0],
        normal1: [0, 0, 1],
        normal2: [c, s, 0],
      });
    }
    const geo = sweepBlendGhost(samples, 1, "fillet");
    expect(geo).not.toBeNull();
    // A closed loop of n segments, each an ARC_SEGMENTS-wide strip.
    expect(geo!.positions.length).toBe(n * ARC_SEGMENTS * 2 * 3 * 3);
    // Every vertex still sits within [R-1, R+1] of the axis (the fillet never
    // reaches further than its own radius past the rim it's rounding).
    for (let i = 0; i < geo!.positions.length; i += 3) {
      const x = geo!.positions[i]!, y = geo!.positions[i + 1]!;
      const rad = Math.hypot(x, y);
      expect(rad).toBeGreaterThan(R - 1 - 1e-6);
      expect(rad).toBeLessThan(R + 1e-6);
    }
  });

  it("returns null when the two faces are nearly flat (no wedge to fit a circle into)", () => {
    const samples: EdgeSample[] = [
      { point: [0, 0, 0], tangent: [0, 0, 1], normal1: [1, 0, 0], normal2: [1, 1e-9, 0] },
      { point: [0, 0, 10], tangent: [0, 0, 1], normal1: [1, 0, 0], normal2: [1, 1e-9, 0] },
    ];
    expect(sweepBlendGhost(samples, 2, "fillet")).toBeNull();
  });

  it("voids the whole edge when only one sample is degenerate", () => {
    const samples: EdgeSample[] = [
      cornerSample(0),
      { point: [0, 0, 5], tangent: [0, 0, 1], normal1: [1, 0, 0], normal2: [1, 0, 0] }, // parallel
      cornerSample(10),
    ];
    expect(sweepBlendGhost(samples, 2, "fillet")).toBeNull();
  });

  it("has nothing to sweep with fewer than 2 samples or a ~zero size", () => {
    expect(sweepBlendGhost([cornerSample(0)], 2, "fillet")).toBeNull();
    expect(sweepBlendGhost([cornerSample(0), cornerSample(10)], 0, "fillet")).toBeNull();
  });
});

describe("sweepBlendGhost / chamfer", () => {
  it("bevels a straight line between the two faces, at `size` along each", () => {
    const d = 3;
    const samples = [cornerSample(0), cornerSample(10)];
    const geo = sweepBlendGhost(samples, d, "chamfer");
    expect(geo).not.toBeNull();
    // 2 points per cross-section: one quad (2 triangles, 6 verts) total.
    expect(geo!.positions.length).toBe(6 * 3);

    const p0 = geo!.positions.slice(0, 3); // face 1's point
    const p1 = geo!.positions.slice(3, 6); // face 2's point
    // On face 1 (x=0) at distance d from the edge, along -y (see module comment).
    expect(p0[0]).toBeCloseTo(0, 6);
    expect(dist(p0, [0, -d, 0])).toBeCloseTo(0, 6);
    // On face 2 (y=0) at distance d from the edge, along -x.
    expect(p1[1]).toBeCloseTo(0, 6);
    expect(dist(p1, [-d, 0, 0])).toBeCloseTo(0, 6);
  });

  it("matches the fillet's own tangent points at the same size", () => {
    // A chamfer and a fillet of the same size touch the faces at the same two
    // points, straight line vs. arc between them.
    const size = 4;
    const samples = [cornerSample(0), cornerSample(1)];
    const chamfer = sweepBlendGhost(samples, size, "chamfer")!;
    const fillet = sweepBlendGhost(samples, size, "fillet")!;
    const chamferStart = chamfer.positions.slice(0, 3);
    const filletStart = fillet.positions.slice(0, 3);
    expect(dist(chamferStart, filletStart)).toBeCloseTo(0, 6);
  });
});
