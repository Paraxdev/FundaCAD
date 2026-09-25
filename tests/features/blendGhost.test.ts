// The ghost's whole value is looking like the real blend at a glance while the
// kernel is still thinking, so these check the geometry against a corner worked
// out by hand rather than against the code that produces it.

import { describe, it, expect } from "vitest";
import { ARC_SEGMENTS, sweepBlendGhost, type EdgeSample } from "../../src/features/blendGhost";

/** A right-angle corner running along Z: face 1 is the x=0 plane running off
 *  toward -y, face 2 the y=0 plane running off toward -x, so the ball of
 *  radius r sits at (-r, -r). */
function cornerSample(z: number, extra: Partial<EdgeSample> = {}): EdgeSample {
  return { point: [0, 0, z], tangent: [0, 0, 1], into1: [0, -1, 0], into2: [-1, 0, 0], ...extra };
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

/** The vertices of the ghost that lie in the cross-section at height z. */
function sectionAt(positions: number[], z: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const p = positions.slice(i, i + 3);
    if (Math.abs(p[2]! - z) < 1e-9) out.push(p);
  }
  return out;
}

describe("sweepBlendGhost / fillet", () => {
  it("sweeps a quarter circle between the two faces along a straight edge", () => {
    const r = 2;
    const geo = sweepBlendGhost([cornerSample(0), cornerSample(10)], r, "fillet");
    expect(geo).not.toBeNull();
    expect(geo!.positions.length).toBe(ARC_SEGMENTS * 6 * 3);

    // The first vertex is face 1's contact point: on x=0, r from the edge.
    const p0 = geo!.positions.slice(0, 3);
    expect(p0[0]).toBeCloseTo(0, 6);
    expect(dist(p0, [0, -r, 0])).toBeCloseTo(0, 6);

    // The last strip's b1 is cross-section 1's last point, face 2's contact.
    const lastStripBase = (ARC_SEGMENTS - 1) * 6 * 3;
    expect(dist(geo!.positions.slice(lastStripBase + 6, lastStripBase + 9), [-r, 0, 10])).toBeCloseTo(0, 6);

    for (const p of sectionAt(geo!.positions, 0)) expect(dist(p, [-r, -r, 0])).toBeCloseTo(r, 5);
  });

  it("puts the ball inside the wedge whichever way the corner turns", () => {
    // The same two half planes bound a convex edge and a concave one alike;
    // the ball always sits between them, never across either face.
    const r = 3;
    const s = (z: number): EdgeSample => ({ point: [0, 0, z], tangent: [0, 0, 1], into1: [0, -1, 0], into2: [1, 0, 0] });
    const geo = sweepBlendGhost([s(0), s(5)], r, "fillet")!;
    for (const p of sectionAt(geo.positions, 0)) {
      expect(dist(p, [r, -r, 0])).toBeCloseTo(r, 5);
      expect(p[0]).toBeGreaterThan(-1e-9);
      expect(p[1]).toBeLessThan(1e-9);
    }
  });

  it("touches each face size/tan(α/2) from the edge in an open wedge", () => {
    const a = (2 * Math.PI) / 3;
    const s = (z: number): EdgeSample => ({
      point: [0, 0, z], tangent: [0, 0, 1], into1: [1, 0, 0], into2: [Math.cos(a), Math.sin(a), 0],
    });
    const r = 2;
    const geo = sweepBlendGhost([s(0), s(1)], r, "fillet")!;
    expect(dist(geo.positions.slice(0, 3), [r / Math.tan(a / 2), 0, 0])).toBeCloseTo(0, 6);
  });

  it("rolls against a curved face, not its tangent plane", () => {
    // Face 2 is a cylinder of radius 10 about (0, 10), leaving the edge along
    // -x and curling away from face 1: a D-shaft's flat meeting its round.
    const R = 10, r = 2;
    const s = (z: number) => cornerSample(z, { bend2: -1 / R });
    const geo = sweepBlendGhost([s(0), s(1)], r, "fillet")!;
    const center = [-r, R - Math.sqrt((R + r) ** 2 - r ** 2), 0];
    const pts = sectionAt(geo.positions, 0);
    for (const p of pts) expect(dist(p, center)).toBeCloseTo(r, 5);
    expect(pts.some((p) => Math.abs(p[0]!) < 1e-6)).toBe(true);
    expect(pts.some((p) => Math.abs(dist(p, [0, R, 0]) - R) < 1e-6)).toBe(true);
  });

  it("never reaches past the end of the shorter face", () => {
    const geo = sweepBlendGhost([cornerSample(0, { reach1: 1 }), cornerSample(10, { reach1: 1 })], 5, "fillet")!;
    for (const p of sectionAt(geo.positions, 0)) expect(dist(p, [-1, -1, 0])).toBeCloseTo(1, 5);
  });

  it("closes a loop back onto its first cross-section", () => {
    const R = 5, n = 12;
    const samples: EdgeSample[] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const c = Math.cos(a), s = Math.sin(a);
      samples.push({ point: [R * c, R * s, 0], tangent: [-s, c, 0], into1: [-c, -s, 0], into2: [0, 0, -1] });
    }
    const open = sweepBlendGhost(samples, 1, "fillet")!;
    const closed = sweepBlendGhost(samples, 1, "fillet", true)!;
    expect(open.positions.length).toBe((n - 1) * ARC_SEGMENTS * 6 * 3);
    expect(closed.positions.length).toBe(n * ARC_SEGMENTS * 6 * 3);
    // the closing strip's b0 is the loop's very first vertex
    const b0 = closed.positions.length - (ARC_SEGMENTS * 6 - 5) * 3;
    expect(dist(closed.positions.slice(b0, b0 + 3), closed.positions.slice(0, 3))).toBeCloseTo(0, 9);
  });

  it("returns null when the two faces are nearly flat (no wedge to fit a circle into)", () => {
    const flat = (z: number): EdgeSample => ({ point: [0, 0, z], tangent: [0, 0, 1], into1: [0, -1, 0], into2: [1e-9, 1, 0] });
    expect(sweepBlendGhost([flat(0), flat(10)], 2, "fillet")).toBeNull();
  });

  it("voids the whole edge when only one sample is degenerate", () => {
    const samples: EdgeSample[] = [
      cornerSample(0),
      { point: [0, 0, 5], tangent: [0, 0, 1], into1: [0, -1, 0], into2: [0, -1, 0] },
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
    const geo = sweepBlendGhost([cornerSample(0), cornerSample(10)], d, "chamfer");
    expect(geo).not.toBeNull();
    expect(geo!.positions.length).toBe(6 * 3);
    expect(dist(geo!.positions.slice(0, 3), [0, -d, 0])).toBeCloseTo(0, 6);
    expect(dist(geo!.positions.slice(3, 6), [-d, 0, 0])).toBeCloseTo(0, 6);
  });

  it("matches the fillet's own tangent points at the same size", () => {
    const size = 4;
    const samples = [cornerSample(0), cornerSample(1)];
    const chamfer = sweepBlendGhost(samples, size, "chamfer")!;
    const fillet = sweepBlendGhost(samples, size, "fillet")!;
    expect(dist(chamfer.positions.slice(0, 3), fillet.positions.slice(0, 3))).toBeCloseTo(0, 6);
  });
});
