import { describe, it, expect } from "vitest";
import {
  GRID_CELL_PX,
  GRID_MAJOR_EVERY,
  gridFalloff,
  gridSegments,
  gridStep,
  MIN_SNAP_STEP,
  snapLatticeStep,
} from "../../src/sketch/planeGrid";

describe("gridStep", () => {
  it("picks a round spacing for a ~64px cell", () => {
    // 0.1 mm per pixel × 64 px = 6.4 mm rough → the nearest nice step is 5.
    expect(gridStep(0.1, 0)).toBe(5);
    expect(gridStep(1 / GRID_CELL_PX, 0)).toBe(1);
  });

  it("honours an explicit floor when one is given", () => {
    // The floor is no longer used by either caller (the snap lattice follows the
    // drawn one now, see snapLatticeStep), but the parameter still means this.
    expect(gridStep(0.001, 5)).toBe(5);
    expect(gridStep(0.02, 5)).toBe(5); // 1.28 rough → 1, floored back to 5
  });

  it("goes finer as you zoom in when nothing floors it", () => {
    expect(gridStep(0.001, 0)).toBeLessThan(1);
  });

  it("still spaces coarsely when zoomed out past the snap step", () => {
    expect(gridStep(1, 5)).toBe(50);
  });

  it("survives a garbage scale", () => {
    expect(gridStep(0, 0)).toBe(1);
    expect(gridStep(NaN, 0)).toBe(1);
    expect(gridStep(0.1, NaN)).toBe(5);
  });
});

describe("snapLatticeStep", () => {
  // The rule: you snap to the lines you can see. It used to be a fixed 5mm while
  // the drawn grid was adaptive, which broke the promise in both directions --
  // zoomed out the cursor caught on 5mm points with no line under them, and
  // zoomed in 5mm was the finest placement available however close you got.

  it("is exactly the spacing that gets drawn", () => {
    // The whole property, stated over a range that spans four decades of zoom.
    for (const wpp of [0.002, 0.01, 0.05, 0.1, 0.4, 1, 4, 20]) {
      expect(snapLatticeStep(wpp), `at ${wpp} mm/px`).toBe(gridStep(wpp, 0));
    }
  });

  it("would have disagreed with the old fixed lattice", () => {
    // Both directions of the defect, so this cannot pass by accident.
    expect(snapLatticeStep(1)).toBeGreaterThan(5);      // zoomed out: 50mm cells
    expect(snapLatticeStep(0.002)).toBeLessThan(5);     // zoomed in: sub-mm cells
  });

  it("never offers a lattice finer than a cursor can aim at", () => {
    // An extreme but VALID zoom. niceStep will happily answer 1e-8 here.
    expect(snapLatticeStep(1e-9)).toBe(MIN_SNAP_STEP);
  });

  it("falls back to a sane lattice on a scale that means nothing", () => {
    // Not the floor: a 0.01mm lattice for an unknown scale would be an
    // effectively free cursor. gridStep's own 1mm answer is the better one, and
    // this is the same fallback the DRAWN grid takes, which is the point.
    for (const bad of [0, NaN, -1, Infinity]) {
      expect(snapLatticeStep(bad), `scale ${bad}`).toBe(gridStep(bad, 0));
      expect(snapLatticeStep(bad)).toBe(1);
    }
  });

  it("never goes backwards as you zoom out", () => {
    let prev = 0;
    for (let e = -4; e <= 3; e += 0.25) {
      const step = snapLatticeStep(Math.pow(10, e));
      expect(step).toBeGreaterThanOrEqual(prev);
      prev = step;
    }
  });
});

describe("gridFalloff", () => {
  it("is full brightness at the centre and dark at the radius", () => {
    expect(gridFalloff(0, 100)).toBe(1);
    expect(gridFalloff(100, 100)).toBe(0);
    expect(gridFalloff(1000, 100)).toBe(0);
  });

  it("decreases all the way out", () => {
    let prev = Infinity;
    for (let d = 0; d <= 100; d += 5) {
      const s = gridFalloff(d, 100);
      expect(s).toBeLessThan(prev);
      prev = s;
    }
  });

  it("arrives at zero flat, so there is no rim", () => {
    // The whole point of the shape: a linear ramp would still be at 5% one step
    // before the end and then stop, which reads as an edge.
    expect(gridFalloff(95, 100)).toBeLessThan(0.02);
  });

  it("holds its brightness where you are actually drawing", () => {
    expect(gridFalloff(20, 100)).toBeGreaterThan(0.9);
  });

  it("returns nothing for a degenerate radius", () => {
    expect(gridFalloff(1, 0)).toBe(0);
    expect(gridFalloff(1, NaN)).toBe(0);
    expect(gridFalloff(NaN, 100)).toBe(0);
  });
});

describe("gridSegments", () => {
  const seg = (g: ReturnType<typeof gridSegments>, i: number) => ({
    x1: g.xy[i * 4]!, y1: g.xy[i * 4 + 1]!, x2: g.xy[i * 4 + 2]!, y2: g.xy[i * 4 + 3]!,
    s1: g.shade[i * 2]!, s2: g.shade[i * 2 + 1]!, major: g.major[i]!,
  });
  const count = (g: ReturnType<typeof gridSegments>) => g.major.length;

  it("emits two vertices and one major flag per segment", () => {
    const g = gridSegments(0, 0, 5, 45);
    expect(g.xy.length).toBe(count(g) * 4);
    expect(g.shade.length).toBe(count(g) * 2);
  });

  it("puts every line on an absolute multiple of the step", () => {
    // Not on offsets from the centre: that is what pins the major lines to the
    // sketch origin and to round coordinates as the centre wanders.
    const g = gridSegments(37, -14, 5, 45);
    for (let i = 0; i < count(g); i++) {
      const s = seg(g, i);
      const onLattice = s.x1 === s.x2 ? s.x1 : s.y1;
      expect(onLattice % 5).toBeCloseTo(0, 9);
    }
  });

  it("marks every Nth line major, counted from the origin", () => {
    const g = gridSegments(0, 0, 5, 45);
    for (let i = 0; i < count(g); i++) {
      const s = seg(g, i);
      const idx = (s.x1 === s.x2 ? s.x1 : s.y1) / 5;
      expect(s.major).toBe(idx % GRID_MAJOR_EVERY === 0);
    }
  });

  it("keeps the major lines on the origin when the centre moves off it", () => {
    // The fade centre follows the cursor; the LATTICE must not follow it, or the
    // bright lines would drift off the round coordinates they are there to mark.
    const g = gridSegments(123, 77, 5, 45);
    for (let i = 0; i < count(g); i++) {
      const s = seg(g, i);
      const idx = (s.x1 === s.x2 ? s.x1 : s.y1) / 5;
      expect(s.major).toBe(Math.abs(idx % GRID_MAJOR_EVERY) === 0);
    }
  });

  it("drops what the fade has already extinguished", () => {
    // This is also what rounds the lattice into a disc instead of a square: the
    // corners of the bounding box are past the radius, so they never exist.
    const g = gridSegments(0, 0, 5, 45);
    for (let i = 0; i < count(g); i++) {
      const s = seg(g, i);
      expect(s.s1 + s.s2).toBeGreaterThan(0);
      expect(Math.max(s.s1, s.s2)).toBeLessThanOrEqual(1);
    }
    // corner of the square that a naive lattice would have drawn
    const far = Math.hypot(45, 45);
    expect(gridFalloff(far, 45)).toBe(0);
  });

  it("fades ALONG a line, not just between lines", () => {
    // Each line is cut at every crossing precisely so its far end can go dark
    // while its middle stays bright. One segment per line would give the whole
    // line one shade and a hard border.
    const g = gridSegments(0, 0, 5, 45);
    const shades = new Set(g.shade);
    expect(shades.size).toBeGreaterThan(5);
  });

  it("is centred: the brightest segment sits at the centre", () => {
    const g = gridSegments(0, 0, 5, 45);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < count(g); i++) {
      const s = seg(g, i);
      const d = Math.hypot((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2);
      if (d < bestD) { bestD = d; best = i; }
    }
    expect(Math.max(seg(g, best).s1, seg(g, best).s2)).toBeCloseTo(1, 1);
  });

  it("returns nothing rather than looping forever on bad input", () => {
    expect(gridSegments(0, 0, 0, 45).major).toHaveLength(0);
    expect(gridSegments(0, 0, 5, 0).major).toHaveLength(0);
    expect(gridSegments(NaN, 0, 5, 45).major).toHaveLength(0);
    expect(gridSegments(0, 0, 1e-6, 1e6).major).toHaveLength(0); // past the cell cap
  });
});
