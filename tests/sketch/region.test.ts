// Unit tests for closed-region detection (src/sketch/region.ts): entityPolyline,
// detectRegions, pointInLoop/pointInRegion.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { detectRegions, entityPolyline, glyphRegion, pointInRegion, rectCorners, rectFromThreePoints } from "../../src/sketch/region";
import type { ResolvedEntity } from "../../src/sketch/snap";

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 });
const rect = (id: string, x: number, y: number, width: number, height: number): ResolvedEntity =>
  ({ type: "rectangle", id, x, y, width, height });
const circle = (id: string, x: number, y: number, radius: number): ResolvedEntity =>
  ({ type: "circle", id, x, y, radius });

describe("entityPolyline", () => {
  it("a line is its two endpoints, open (no closing vertex)", () => {
    const p = entityPolyline(line("l1", 0, 0, 5, 0));
    expect(p).toEqual([new THREE.Vector2(0, 0), new THREE.Vector2(5, 0)]);
  });

  it("a rectangle's polyline repeats its first corner to close the loop", () => {
    const p = entityPolyline(rect("r1", 0, 0, 10, 4));
    expect(p).toHaveLength(5); // 4 corners + repeated first
    expect(p[0]).toEqual(p[4]);
  });

  it("a circle's polyline repeats its first sampled point to close the loop", () => {
    const p = entityPolyline(circle("c1", 0, 0, 3));
    expect(p[0]).toEqual(p[p.length - 1]);
    expect(p.length).toBeGreaterThan(3);
  });
});

describe("glyphRegion — a tessellated glyph face becomes an extrudable profile", () => {
  it("a square outer with a square hole yields a ring whose interior avoids the hole", () => {
    // 10×10 outer, 4×4 centered hole (like the counter of an 'O')
    const outer: [number, number][] = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
    const holes: [number, number][][] = [[[-2, -2], [2, -2], [2, 2], [-2, 2]]];
    const region = glyphRegion("s1", outer, holes);

    expect(region.sketchId).toBe("s1");
    expect(region.loop).toHaveLength(4);
    expect(region.holes).toHaveLength(1);
    // the selection anchor must sit in the material — inside the outer, outside the hole
    expect(pointInRegion(region.interior, region)).toBe(true);
    // a point in the counter (hole) is NOT part of the material
    expect(pointInRegion(new THREE.Vector2(0, 0), region)).toBe(false);
  });

  it("a solid glyph face (no holes) keeps its whole area", () => {
    const outer: [number, number][] = [[0, 0], [6, 0], [6, 4], [0, 4]];
    const region = glyphRegion("s1", outer, []);
    expect(region.holes).toHaveLength(0);
    expect(pointInRegion(new THREE.Vector2(3, 2), region)).toBe(true);
  });
});

describe("detectRegions — simple closed rectangle", () => {
  it("a single rectangle entity yields exactly one region with no holes", () => {
    const regions = detectRegions("s1", [rect("r1", 0, 0, 10, 6)]);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.holes).toHaveLength(0);
    // loop is the 4 rectangle corners (unclosed, no repeated last point)
    expect(regions[0]?.loop).toHaveLength(4);
  });

  it("a 4-line closed loop (chained by shared endpoints) also yields one region", () => {
    const entities = [
      line("l1", -5, -5, 5, -5),
      line("l2", 5, -5, 5, 5),
      line("l3", 5, 5, -5, 5),
      line("l4", -5, 5, -5, -5),
    ];
    const regions = detectRegions("s1", entities);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.holes).toHaveLength(0);
  });

  it("an open 3-line chain (missing the closing side) yields no region", () => {
    const entities = [
      line("l1", -5, -5, 5, -5),
      line("l2", 5, -5, 5, 5),
      line("l3", 5, 5, -5, 5),
      // no l4 closing back to (-5, -5): the chain never closes
    ];
    const regions = detectRegions("s1", entities);
    expect(regions).toHaveLength(0);
  });
});

describe("detectRegions — circle-inside-rectangle hole handling", () => {
  // Non-crossing (circle entirely inside, not touching the rectangle boundary):
  // the fast path treats each as its own loop, then nests by containment —
  // a ring (rect w/ hole=circle) AND the disk (circle, no holes), per the code's
  // own comment at region.ts:131-132.
  const entities = [rect("r1", 0, 0, 20, 20), circle("c1", 0, 0, 3)];

  it("yields two regions: the outer ring (hole=circle) and the inner disk", () => {
    const regions = detectRegions("s1", entities);
    expect(regions).toHaveLength(2);
    const ring = regions.find((r) => r.holes.length > 0)!;
    const disk = regions.find((r) => r.holes.length === 0)!;
    expect(ring).toBeDefined();
    expect(disk).toBeDefined();
    expect(ring.holes).toHaveLength(1);
    expect(ring.loop).toHaveLength(4); // the rectangle
    expect(disk.loop.length).toBeGreaterThan(4); // the sampled circle
  });

  it("pointInRegion: material of the ring excludes the hole's interior", () => {
    const regions = detectRegions("s1", entities);
    const ring = regions.find((r) => r.holes.length > 0)!;
    const disk = regions.find((r) => r.holes.length === 0)!;

    // center of the circle: inside the disk, but excluded from the ring's material
    expect(pointInRegion(new THREE.Vector2(0, 0), disk)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(0, 0), ring)).toBe(false);

    // a point between the circle and the rectangle boundary: in the ring's
    // material, but outside the disk
    expect(pointInRegion(new THREE.Vector2(8, 8), ring)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(8, 8), disk)).toBe(false);

    // a point outside the rectangle entirely: in neither region
    expect(pointInRegion(new THREE.Vector2(100, 100), ring)).toBe(false);
    expect(pointInRegion(new THREE.Vector2(100, 100), disk)).toBe(false);
  });
});

describe("detectRegions — thin-ring interior anchor (field bug: outer ring selects inner circle)", () => {
  // Two concentric circles with a thin ring (inner_r/outer_r = 0.914 > 0.9), the
  // exact Test1 document geometry. The region's `interior` anchor MUST land in the
  // ring material — not in the hole. When it fell in the hole (0,0), selecting the
  // ring stored an anchor inside the disk, so the disk highlighted/extruded instead.
  it("the annulus anchor is inside its own material, not the hole", () => {
    const regions = detectRegions("s1", [circle("outer", 0, 0, 27.5), circle("inner", 0, 0, 25.123885645485018)]);
    expect(regions).toHaveLength(2);
    const annulus = regions.find((r) => r.holes.length > 0)!;
    const disk = regions.find((r) => r.holes.length === 0)!;
    // the anchor must be in the annulus material and NOT in the disk (the hole)
    expect(pointInRegion(annulus.interior, annulus)).toBe(true);
    expect(pointInRegion(annulus.interior, disk)).toBe(false);
  });
});

describe("detectRegions — projected reference geometry forms profiles", () => {
  const pline = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({
    type: "projected", id,
    source: { kind: "edge", body: "body1", sel: { kind: "edge", by: "match", fp: { mid: [0, 0, 0], dir: [1, 0, 0] } } },
    curve: { kind: "line", x1, y1, x2, y2 },
  });

  it("a square of 4 projected lines chains into one region", () => {
    const regions = detectRegions("s1", [
      pline("p1", 0, 0, 20, 0),
      pline("p2", 20, 0, 20, 20),
      pline("p3", 20, 20, 0, 20),
      pline("p4", 0, 20, 0, 0),
    ]);
    expect(regions).toHaveLength(1);
    expect(pointInRegion(new THREE.Vector2(10, 10), regions[0]!)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(30, 10), regions[0]!)).toBe(false);
  });

  it("a projected circle is its own closed loop (fast path, like a native circle)", () => {
    const pc: ResolvedEntity = {
      type: "projected", id: "pc",
      source: { kind: "silhouette", body: "body1" },
      curve: { kind: "circle", x: 0, y: 0, r: 5 },
    };
    const regions = detectRegions("s1", [pc]);
    expect(regions).toHaveLength(1);
    expect(pointInRegion(new THREE.Vector2(0, 0), regions[0]!)).toBe(true);
    expect(pointInRegion(new THREE.Vector2(6, 0), regions[0]!)).toBe(false);
  });

  it("a construction projected entity never forms a profile", () => {
    const pc: ResolvedEntity = {
      type: "projected", id: "pc",
      source: { kind: "silhouette", body: "body1" },
      curve: { kind: "circle", x: 0, y: 0, r: 5 },
      construction: true,
    };
    expect(detectRegions("s1", [pc])).toHaveLength(0);
  });
});

describe("detectRegions — splitting a profile at the edge of the face it sits on", () => {
  // The 20x20 face of a box, in sketch coordinates. A sketch drawn on a face is
  // bounded by that face as much as by its own curves, and until this existed
  // the whole profile was one region that extruded off the side of the part.
  const face: THREE.Vector2[][] = [
    [
      new THREE.Vector2(-10, -10),
      new THREE.Vector2(10, -10),
      new THREE.Vector2(10, 10),
      new THREE.Vector2(-10, 10),
    ],
  ];

  /** Shoelace area of a loop, for checking that a split conserves material. */
  const area = (loop: THREE.Vector2[]) => {
    let a = 0;
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i]!;
      const q = loop[(i + 1) % loop.length]!;
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  };

  it("cuts a profile that hangs off the edge into an on-face part and an overhang", () => {
    // A circle centred on the face's right edge: half on the part, half in air.
    const regions = detectRegions("s1", [circle("c", 10, 0, 6)], face);
    expect(regions.length).toBe(2);
    const kinds = regions.map((r) => r.support).sort();
    expect(kinds).toEqual(["on-face", "overhang"]);
  });

  it("keeps the two halves' anchors on the side they claim to be on", () => {
    // The support flag is what a tool will branch on, so it has to agree with
    // the geometry rather than merely be present. The anchor is the point the
    // selection is stored as, so it is the one that must be on the right side.
    const regions = detectRegions("s1", [circle("c", 10, 0, 6)], face);
    for (const r of regions) {
      const inside = r.interior.x < 10;
      expect(r.support).toBe(inside ? "on-face" : "overhang");
    }
  });

  it("conserves the profile's area across the split", () => {
    // The failure this prevents is the quiet one: an arrangement that drops a
    // cell leaves the user with a profile smaller than the one they drew, and
    // nothing on screen says so until the extrude comes out wrong.
    const whole = detectRegions("s1", [circle("c", 10, 0, 6)]);
    const split = detectRegions("s1", [circle("c", 10, 0, 6)], face);
    const before = whole.reduce((s, r) => s + area(r.loop), 0);
    const after = split.reduce((s, r) => s + area(r.loop), 0);
    expect(after).toBeCloseTo(before, 3);
  });

  it("leaves a profile wholly on the face as one region", () => {
    // Re-running the arrangement when nothing crosses would cost time and risk
    // perturbing loops that were already right, so that path is skipped — but
    // the region must still be MARKED, because a tool needs to know it is
    // supported, not merely that it was not split.
    const regions = detectRegions("s1", [circle("c", 0, 0, 4)], face);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.support).toBe("on-face");
  });

  it("marks a profile wholly off the face as overhanging, without splitting it", () => {
    const regions = detectRegions("s1", [circle("c", 40, 0, 4)], face);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.support).toBe("overhang");
  });

  it("says null, not overhang, when there is no face behind the sketch", () => {
    // A datum-plane sketch was never measured against anything. Reading that as
    // "overhang" would make every such profile look unsupported and would send a
    // tool down the wrong branch for the most ordinary sketch there is.
    const regions = detectRegions("s1", [circle("c", 0, 0, 4)]);
    expect(regions[0]!.support ?? null).toBeNull();
  });

  it("does not turn the face itself into a selectable region", () => {
    // Feeding the outline into the arrangement makes it produce cells for the
    // FACE as well — most obviously "the face minus the profile", which is
    // bounded by the outline and the profile and looks just like a legitimate
    // mixed cell. The user drew a circle, not a plate with a hole in it.
    const regions = detectRegions("s1", [circle("c", 10, 0, 6)], face);
    const faceArea = 20 * 20;
    for (const r of regions) expect(area(r.loop)).toBeLessThan(faceArea / 2);
  });

  it("treats a hole in the face as nothing to sit on", () => {
    // Even-odd, so a profile over the bore of a washer-shaped face is
    // overhanging: there is no material under it to cut into or add flush to.
    const washer: THREE.Vector2[][] = [face[0]!, circleLoopFor(0, 0, 5)];
    const regions = detectRegions("s1", [circle("c", 0, 0, 2)], washer);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.support).toBe("overhang");
  });
});

function circleLoopFor(cx: number, cy: number, r: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    out.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return out;
}

describe("rectCorners rotation", () => {
  const at = (pts: THREE.Vector2[], i: number) => {
    const p = pts[i];
    if (!p) throw new Error(`no corner ${i}`);
    return p;
  };

  it("returns the axis-aligned corners EXACTLY when there is no angle", () => {
    // Every rectangle in every saved document takes this path. Routing them
    // through a cos/sin would move them by float noise, which is a diff in every
    // file anyone opens and re-saves.
    for (const a of [0, undefined]) {
      const c = rectCorners(3, 5, 10, 4, a);
      expect(c.map((p) => [p.x, p.y])).toEqual([[-2, 3], [8, 3], [8, 7], [-2, 7]]);
    }
  });

  it("rotates about the rectangle's own centre, not the origin", () => {
    // Rotating about the origin would send an off-centre rectangle across the
    // sketch the moment it was given an angle.
    const c = rectCorners(100, 0, 10, 4, 90);
    const cx = c.reduce((s, p) => s + p.x, 0) / 4;
    const cy = c.reduce((s, p) => s + p.y, 0) / 4;
    expect(cx).toBeCloseTo(100, 9);
    expect(cy).toBeCloseTo(0, 9);
  });

  it("reads the angle as DEGREES, like every other angle field", () => {
    // 90 degrees swaps the extents; 90 RADIANS would not.
    const c = rectCorners(0, 0, 10, 4, 90);
    const xs = c.map((p) => p.x);
    const ys = c.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(10, 9);
  });

  it("keeps the CCW corner order the edge addressing depends on", () => {
    // "<rectId>~k" names edge k in this order. A rotation that reordered or
    // reversed the corners would silently re-target every dimension and
    // constraint attached to a rectangle edge.
    const c = rectCorners(0, 0, 10, 4, 30);
    const area =
      c.reduce((s, p, i) => {
        const q = at(c, (i + 1) % 4);
        return s + (p.x * q.y - q.x * p.y);
      }, 0) / 2;
    expect(area).toBeGreaterThan(0); // positive => counter-clockwise
    expect(area).toBeCloseTo(40, 6); // and still 10 x 4
  });

  it("stays a rectangle: opposite sides equal, corners square", () => {
    const c = rectCorners(-7, 2, 10, 4, 37.5);
    const side = (i: number) => at(c, (i + 1) % 4).clone().sub(at(c, i));
    expect(side(0).length()).toBeCloseTo(10, 9);
    expect(side(1).length()).toBeCloseTo(4, 9);
    expect(side(2).length()).toBeCloseTo(10, 9);
    expect(side(0).dot(side(1))).toBeCloseTo(0, 9);
  });

  it("gives entityPolyline a closed rotated loop", () => {
    // The one place an entity becomes points — everything downstream (regions,
    // picking, snapping, the sidecar's own corners) reads through it.
    const p = entityPolyline({ type: "rectangle", id: "r", x: 0, y: 0, width: 10, height: 4, angle: 45 } as never);
    expect(p).toHaveLength(5);
    expect(at(p, 0).x).toBeCloseTo(at(p, 4).x, 9);
    expect(at(p, 0).y).toBeCloseTo(at(p, 4).y, 9);
    expect(at(p, 0).y).not.toBeCloseTo(at(p, 1).y, 6); // genuinely rotated
  });
});

describe("rectFromThreePoints", () => {
  const v = (x: number, y: number) => new THREE.Vector2(x, y);
  const corner = (pts: THREE.Vector2[], i: number) => pts[i]!;

  it("is the exact inverse of rectCorners", () => {
    // Three of the four corners a rotated rectangle already has must give that
    // rectangle back. This is the seam: the tool writes what this returns, and
    // everything downstream reads it through rectCorners.
    const pts = rectCorners(-7, 2, 10, 4, 37.5);
    const r = rectFromThreePoints(corner(pts, 0), corner(pts, 1), corner(pts, 2))!;
    expect(r.x).toBeCloseTo(-7, 9);
    expect(r.y).toBeCloseTo(2, 9);
    expect(r.width).toBeCloseTo(10, 9);
    expect(r.height).toBeCloseTo(4, 9);
    expect(r.angle).toBeCloseTo(37.5, 9);
  });

  it("takes a→b as the full edge, and its direction as the angle", () => {
    const r = rectFromThreePoints(v(0, 0), v(10, 0), v(10, 4))!;
    expect(r).toEqual({ x: 5, y: 2, width: 10, height: 4, angle: 0 });
    const turned = rectFromThreePoints(v(0, 0), v(0, 10), v(-4, 10))!;
    expect(turned.width).toBeCloseTo(10, 9);
    expect(turned.height).toBeCloseTo(4, 9);
    expect(turned.angle).toBeCloseTo(90, 9);
  });

  it("measures the third point PERPENDICULARLY to the edge", () => {
    // Sliding the cursor ALONG the edge must not change the shape — otherwise
    // the rectangle creeps sideways while the user is choosing its thickness.
    const base = rectFromThreePoints(v(0, 0), v(10, 0), v(3, 4))!;
    for (const x of [-50, 0, 5, 10, 60]) {
      expect(rectFromThreePoints(v(0, 0), v(10, 0), v(x, 4))).toEqual(base);
    }
  });

  it("grows toward the cursor rather than jumping across the edge", () => {
    const up = rectFromThreePoints(v(0, 0), v(10, 0), v(5, 4))!;
    const down = rectFromThreePoints(v(0, 0), v(10, 0), v(5, -4))!;
    expect(up.y).toBeCloseTo(2, 9);
    expect(down.y).toBeCloseTo(-2, 9);
    expect(up.height).toBeCloseTo(down.height, 9); // magnitude only, never negative
  });

  it("refuses the degenerate clicks instead of emitting a zero rectangle", () => {
    // A committed rectangle of no area is invisible, unselectable and extrudes
    // to nothing — a rejected click is the honest answer.
    expect(rectFromThreePoints(v(3, 3), v(3, 3), v(9, 9))).toBeNull(); // no edge
    expect(rectFromThreePoints(v(0, 0), v(10, 0), v(4, 0))).toBeNull(); // c on the edge
  });
});

describe("detectRegions — every closed primitive is a profile, not just the two", () => {
  // Field bug: a slot drew fine and highlighted nothing. A slot and a polygon
  // are closed curves with no free endpoints, so the chain tracer has nothing to
  // join them to; only the entities the fast path names as loops of their own
  // ever became regions, and that list was rectangle + circle.
  const slot = (id: string, x1: number, y1: number, x2: number, y2: number, width: number): ResolvedEntity =>
    ({ type: "slot", id, x1, y1, x2, y2, width });
  const poly = (id: string, x: number, y: number, radius: number, sides: number): ResolvedEntity =>
    ({ type: "polygon", id, x, y, radius, sides, angle: 0 });

  it("a slot is one region, and the point between its arc centres is in it", () => {
    const regions = detectRegions("s1", [slot("s", -10, 0, 10, 0, 8)]);
    expect(regions).toHaveLength(1);
    const r = regions[0]!;
    expect(r.holes).toHaveLength(0);
    expect(pointInRegion(new THREE.Vector2(0, 0), r)).toBe(true);
    // the cap ends reach past the centres by the half width...
    expect(pointInRegion(new THREE.Vector2(13.5, 0), r)).toBe(true);
    // ...but not beyond, or the outline is not the one being drawn
    expect(pointInRegion(new THREE.Vector2(15, 0), r)).toBe(false);
    // and the corner of the bounding box is outside a rounded end
    expect(pointInRegion(new THREE.Vector2(13.5, 3.9), r)).toBe(false);
  });

  it("a polygon is one region", () => {
    const regions = detectRegions("s1", [poly("p", 0, 0, 10, 6)]);
    expect(regions).toHaveLength(1);
    expect(pointInRegion(new THREE.Vector2(0, 0), regions[0]!)).toBe(true);
  });

  it("a slot inside a rectangle cuts a hole in it, like a circle does", () => {
    const regions = detectRegions("s1", [rect("r1", 0, 0, 60, 40), slot("s", -8, 0, 8, 0, 6)]);
    expect(regions).toHaveLength(2);
    const ring = regions.find((r) => r.holes.length > 0)!;
    expect(ring).toBeDefined();
    expect(pointInRegion(new THREE.Vector2(0, 0), ring)).toBe(false);
    expect(pointInRegion(new THREE.Vector2(25, 15), ring)).toBe(true);
  });

  it("construction geometry is still reference-only", () => {
    // The rule that must survive the widening: a construction slot is not a
    // profile, or every centreline turns into an extrudable area.
    const c: ResolvedEntity = { ...slot("s", -10, 0, 10, 0, 8), construction: true } as ResolvedEntity;
    expect(detectRegions("s1", [c])).toHaveLength(0);
  });
});
