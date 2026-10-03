// The two things that are silent when wrong: the sign sent to the kernel (a hole
// that shrinks when you drag it open), and where the resize stops being a resize.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  COLLAPSE_FRACTION,
  collapseDiameter,
  deltaForDiameter,
  deltaForRadius,
  facetNormalAt,
  radialDrag,
  roundFromResize,
} from "../../src/features/radialDrag";
import type { OfferedResize } from "../../src/features/pressPullAxis";

describe("radialDrag", () => {
  it("reads the drag as a diameter, not a radius", () => {
    // A 10mm shaft (r=5) pulled 1mm outward is 12 across, not 11.
    expect(radialDrag(5, 1, true).diameter).toBeCloseTo(12);
    expect(radialDrag(5, 0, true).diameter).toBeCloseTo(10);
    expect(radialDrag(5, -1, true).diameter).toBeCloseTo(8);
  });

  it("pulls outward = bigger, on a bore as well as a boss", () => {
    // The handle points away from the axis in both cases, so the DIAMETER must
    // agree in both cases. Only the kernel's sign differs.
    expect(radialDrag(5, 1.5, true).diameter).toBeCloseTo(radialDrag(5, 1.5, false).diameter);
  });

  it("flips the kernel's sign for a bore", () => {
    // A press/pull distance moves the face along its own outward normal, which
    // points at the axis on a hole. Get this backwards and a hole dragged open
    // closes instead, no error, just the wrong part.
    expect(radialDrag(5, 1, true).distance).toBeCloseTo(1);
    expect(radialDrag(5, 1, false).distance).toBeCloseTo(-1);
    expect(radialDrag(5, -0.4, true).distance).toBeCloseTo(-0.4);
    expect(radialDrag(5, -0.4, false).distance).toBeCloseTo(0.4);
  });

  it("becomes a removal at the smallest size the kernel will build", () => {
    // The engine clamps an inward offset at 90% of the radius, so 10% is the
    // floor. Asking for less has to mean something other than "smaller".
    const r = 5;
    const floor = r * COLLAPSE_FRACTION;
    expect(radialDrag(r, -(r - floor) + 0.01, true).mode).toBe("resize");
    expect(radialDrag(r, -(r - floor), true).mode).toBe("remove");
    expect(radialDrag(r, -r, true).mode).toBe("remove"); // exactly zero
    expect(radialDrag(r, -r - 1, true).mode).toBe("remove"); // dragged past it
  });

  it("sends no distance while removing", () => {
    // Removal is a different feature (defeature/heal), not a very large push:
    // handing the kernel -6 on a 5mm radius is the collapse the clamp exists to
    // prevent, and it would come back clamped to -4.5, a resize nobody asked for.
    const d = radialDrag(5, -9, true);
    expect(d.mode).toBe("remove");
    expect(d.distance).toBe(0);
    expect(d.diameter).toBe(0);
  });

  it("is reversible: the same delta always reads the same, either direction", () => {
    // What makes the gesture safe to explore, crossing the floor and coming back
    // has to land on the number you left, or a slip of the mouse costs the size.
    const before = radialDrag(5, -1, true);
    radialDrag(5, -9, true); // through the floor
    expect(radialDrag(5, -1, true)).toEqual(before);
  });

  it("refuses a degenerate radius rather than inventing a size", () => {
    for (const r of [0, -1, NaN, Infinity]) expect(radialDrag(r, 1, true).mode).toBe("remove");
    expect(radialDrag(5, NaN, true).mode).toBe("remove");
  });

  it("round-trips a typed diameter through the drag", () => {
    for (const d of [12, 8, 1.5]) {
      expect(radialDrag(5, deltaForDiameter(5, d), true).diameter).toBeCloseTo(d, 9);
    }
    // typing 0 does what dragging to 0 does, and so does anything under the
    // floor, which is why the round trip above stays above it
    expect(radialDrag(5, deltaForDiameter(5, 0), true).mode).toBe("remove");
    expect(radialDrag(5, deltaForDiameter(5, 0.5), true).mode).toBe("remove");
  });

  it("reports the floor as a diameter, since that is what the readout speaks", () => {
    expect(collapseDiameter(5)).toBeCloseTo(1);
  });

  it("never removes a partial arc, however far it is pushed in", () => {
    // A slot end has no hole to take away, so its size keeps reading as a size
    // and the engine says why the smaller ones cannot be built.
    expect(radialDrag(5, -4.9, true, false).mode).toBe("resize");
    expect(radialDrag(5, -5, true, false).mode).toBe("resize");
    const past = radialDrag(2, -3, false, false);
    expect(past.mode).toBe("resize");
    expect(past.radius).toBeCloseTo(-1);
    expect(past.distance).toBeCloseTo(3);
    expect(radialDrag(5, -4.9, true, true).mode).toBe("remove");
  });

  it("round-trips a typed radius through the drag", () => {
    for (const target of [2.6, 2, 1.5, 0.05]) {
      for (const inside of [true, false]) {
        expect(radialDrag(2, deltaForRadius(2, target), inside, false).radius).toBeCloseTo(target, 9);
      }
    }
  });

  it("signs a typed radius for the kernel on a bore and on a boss", () => {
    const table: [boolean, number, number][] = [
      [false, 2.6, -0.6], // bore grown
      [false, 1.5, 0.5], // bore shrunk
      [true, 2.6, 0.6], // boss grown
      [true, 1.5, -0.5], // boss shrunk
    ];
    for (const [inside, target, distance] of table) {
      expect(radialDrag(2, deltaForRadius(2, target), inside, false).distance).toBeCloseTo(distance, 9);
    }
  });
});

describe("roundFromResize", () => {
  const tangent = { faces: 0, lostWhen: null, run: [], closed: false, followable: false };
  const read = (kind: OfferedResize["kind"], extra: Partial<OfferedResize> = {}): OfferedResize =>
    ({ kind, radius: 4, full: false, concave: true, contact: null, tangent, ...extra });
  const near = (v: THREE.Vector3 | number[]) => (Array.isArray(v) ? v : v.toArray()).map((c) => Math.round(c * 1e9) / 1e9 + 0);

  it("reads a sphere about its centre, the arrow pointing away from it", () => {
    const r = roundFromResize(read("sphere", { centre: [0, 0, 10] }), null, [0, 3, 6]);
    expect(r).not.toBeNull();
    expect(r!.centre).toEqual([0, 0, 10]);
    expect(near(r!.radial)).toEqual([0, 0.6, -0.8]);
    expect(r!.radius).toBe(4);
    expect(r!.solidInside).toBe(false);
    expect(r!.full).toBe(false);
    // The guide line runs through the centre square to the arrow, so the size line starts there.
    expect(r!.cylinder.point).toEqual([0, 0, 10]);
    expect(Math.abs(new THREE.Vector3(...r!.cylinder.axis).dot(r!.radial))).toBeLessThan(1e-9);
  });

  it("a ball reads with the material inside it", () => {
    expect(roundFromResize(read("sphere", { centre: [0, 0, 0], concave: false }), null, [4, 0, 0])!.solidInside).toBe(true);
  });

  it("reads a cylinder about the engine's axis", () => {
    const r = roundFromResize(read("cylinder", { full: true }), { origin: [0, 0, 0], dir: [0, 0, 1] }, [0, 4, 7]);
    expect(near(r!.radial)).toEqual([0, 1, 0]);
    expect(r!.centre).toBeUndefined();
    expect(r!.full).toBe(true);
  });

  it("has no round face for a cone or a torus, or a point with no direction away", () => {
    expect(roundFromResize(read("cone", { radius: 0 }), { origin: [0, 0, 0], dir: [0, 0, 1] }, [1, 0, 1])).toBeNull();
    expect(roundFromResize(read("torus"), { origin: [0, 0, 0], dir: [0, 0, 1] }, [5, 0, 0])).toBeNull();
    expect(roundFromResize(read("sphere", { centre: [1, 2, 3] }), null, [1, 2, 3])).toBeNull();
    expect(roundFromResize(read("cylinder"), null, [0, 4, 0])).toBeNull();
  });
});

describe("facetNormalAt", () => {
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  it("takes the facet under the point, not the face's average", () => {
    // Two facets of a cone round its axis, the average of which points up it.
    const left = new THREE.Triangle(V(-2, 0, 0), V(-1, -1, 1), V(-1, 1, 1));
    const right = new THREE.Triangle(V(2, 0, 0), V(1, 1, 1), V(1, -1, 1));
    const n = facetNormalAt([left, right], V(1.3, 0, 0.6))!;
    expect(n.x).toBeCloseTo(Math.SQRT1_2, 9);
    expect(n.y).toBeCloseTo(0, 9);
    expect(n.z).toBeCloseTo(Math.SQRT1_2, 9);
    expect(facetNormalAt([left, right], V(-1.3, 0, 0.6))!.x).toBeCloseTo(-Math.SQRT1_2, 9);
  });

  it("skips a degenerate facet and has nothing for no facets", () => {
    const sliver = new THREE.Triangle(V(0, 0, 0), V(0, 0, 0), V(1, 0, 0));
    const flat = new THREE.Triangle(V(-5, -5, 0), V(5, -5, 0), V(0, 5, 0));
    expect(facetNormalAt([sliver, flat], V(0, 0, 0))!.toArray()).toEqual([0, 0, 1]);
    expect(facetNormalAt([], V(0, 0, 0))).toBeNull();
  });
});
