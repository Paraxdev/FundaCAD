import { describe, it, expect } from "vitest";
import {
  GRID_CELL_PX,
  GRID_COVER,
  GRID_MAJOR_EVERY,
  gridLines,
  gridReach,
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

describe("gridReach", () => {
  // The whole reason the lattice stopped fading: how far it has to run is a
  // question about the VIEWPORT, and the viewport can answer it.

  it("covers more than the corner of the screen", () => {
    // Half a diagonal reaches the corners of a view seen flat on. Anything less
    // than that and the grid ends inside the window.
    const wpp = 0.1;
    const diag = 2000;
    expect(gridReach(wpp, diag)).toBeGreaterThan((wpp * diag) / 2);
  });

  it("is the same number of SCREENFULS at every zoom", () => {
    // The property that makes it a rule rather than a constant: doubling the
    // world each pixel covers doubles the reach, so the grid looks identical.
    for (const wpp of [0.001, 0.01, 0.1, 1, 10]) {
      expect(gridReach(wpp * 2, 1500) / gridReach(wpp, 1500)).toBeCloseTo(2, 9);
    }
  });

  it("is GRID_COVER diagonals, stated once", () => {
    expect(gridReach(0.25, 1600)).toBeCloseTo(0.25 * 1600 * GRID_COVER, 9);
  });

  it("asks for nothing on a scale that means nothing", () => {
    for (const bad of [0, -1, NaN, Infinity]) expect(gridReach(bad, 1600)).toBe(0);
    expect(gridReach(0.1, 0)).toBe(0);
  });
});

describe("gridLines", () => {
  const all = (g: ReturnType<typeof gridLines>) => [...g.minor, ...g.major];
  const lineCount = (g: ReturnType<typeof gridLines>) => all(g).length / 4;
  const line = (xy: number[], i: number) => ({
    x1: xy[i * 4]!, y1: xy[i * 4 + 1]!, x2: xy[i * 4 + 2]!, y2: xy[i * 4 + 3]!,
  });

  it("emits four numbers per line and nothing else", () => {
    const g = gridLines(0, 0, 5, 100);
    expect(g.minor.length % 4).toBe(0);
    expect(g.major.length % 4).toBe(0);
    expect(lineCount(g)).toBeGreaterThan(10);
  });

  it("runs each line the WHOLE way across, not cell by cell", () => {
    // This is what dropping the fade bought, and it is the reason the lattice
    // can afford to be a screenful wide: a fade has to vary along a line, so it
    // needs one segment per cell crossed; a uniform line needs one, full stop.
    const g = gridLines(0, 0, 5, 100);
    for (let i = 0; i < lineCount(g); i++) {
      const l = line(all(g), i);
      // The full span of the lattice, every time: 100 either side of the centre
      // and never a cell's worth of it.
      expect(Math.hypot(l.x2 - l.x1, l.y2 - l.y1)).toBeGreaterThanOrEqual(200);
    }
  });

  it("puts every line on an absolute multiple of the step", () => {
    // Not on offsets from the centre: that is what pins the major lines to the
    // sketch origin and to round coordinates as the view wanders.
    const g = gridLines(37, -14, 5, 100);
    for (let i = 0; i < lineCount(g); i++) {
      const l = line(all(g), i);
      const onLattice = l.x1 === l.x2 ? l.x1 : l.y1;
      expect(onLattice % 5).toBeCloseTo(0, 9);
    }
  });

  it("marks every Nth line major, counted from the origin", () => {
    const g = gridLines(0, 0, 5, 100);
    for (const [xy, wantMajor] of [[g.major, true], [g.minor, false]] as const) {
      for (let i = 0; i < xy.length / 4; i++) {
        const l = line(xy, i);
        const idx = (l.x1 === l.x2 ? l.x1 : l.y1) / 5;
        expect(Math.abs(idx % GRID_MAJOR_EVERY) === 0).toBe(wantMajor);
      }
    }
  });

  it("keeps the major lines on the origin when the view moves off it", () => {
    const g = gridLines(123, 77, 5, 100);
    for (let i = 0; i < g.major.length / 4; i++) {
      const l = line(g.major, i);
      const idx = (l.x1 === l.x2 ? l.x1 : l.y1) / 5;
      expect(Math.abs(idx % GRID_MAJOR_EVERY)).toBe(0);
    }
  });

  it("puts both ends of every line OUTSIDE what was asked for", () => {
    // The control on "infinite": the reach is the viewport, so a line that
    // stopped inside it would be a line whose end you can see. There is no
    // interior edge to find, in either axis, from any centre.
    for (const [cx, cy] of [[0, 0], [123, -77], [-4.2, 9.9]] as const) {
      const g = gridLines(cx, cy, 5, 100);
      expect(lineCount(g)).toBeGreaterThan(0);
      for (let i = 0; i < lineCount(g); i++) {
        const l = line(all(g), i);
        if (l.x1 === l.x2) {
          expect(Math.min(l.y1, l.y2)).toBeLessThanOrEqual(cy - 100);
          expect(Math.max(l.y1, l.y2)).toBeGreaterThanOrEqual(cy + 100);
        } else {
          expect(Math.min(l.x1, l.x2)).toBeLessThanOrEqual(cx - 100);
          expect(Math.max(l.x1, l.x2)).toBeGreaterThanOrEqual(cx + 100);
        }
      }
    }
  });

  it("covers the square it was asked for in both directions", () => {
    // The other half of the same promise: not just long lines, but lines on
    // every lattice multiple across the whole reach.
    const g = gridLines(0, 0, 5, 100);
    const vertical = new Set<number>();
    const horizontal = new Set<number>();
    for (let i = 0; i < lineCount(g); i++) {
      const l = line(all(g), i);
      (l.x1 === l.x2 ? vertical : horizontal).add(l.x1 === l.x2 ? l.x1 : l.y1);
    }
    for (const set of [vertical, horizontal]) {
      expect(Math.min(...set)).toBeLessThanOrEqual(-100);
      expect(Math.max(...set)).toBeGreaterThanOrEqual(100);
      expect(set.size).toBe(41); // -100..100 by 5, inclusive
    }
  });

  it("follows the centre it is given", () => {
    // The disc it replaced never moved off the sketch origin, so panning away
    // left you drawing on nothing.
    const away = gridLines(1000, 1000, 5, 100);
    expect(away.minor.length + away.major.length).toBeGreaterThan(0);
    for (let i = 0; i < lineCount(away); i++) {
      const l = line(all(away), i);
      const onLattice = l.x1 === l.x2 ? l.x1 : l.y1;
      expect(Math.abs(onLattice - 1000)).toBeLessThanOrEqual(105);
    }
  });

  it("returns nothing rather than looping forever on bad input", () => {
    for (const g of [
      gridLines(0, 0, 0, 100),
      gridLines(0, 0, 5, 0),
      gridLines(NaN, 0, 5, 100),
      gridLines(0, 0, 1e-6, 1e6), // past the per-axis line cap
    ]) {
      expect(g.minor).toHaveLength(0);
      expect(g.major).toHaveLength(0);
    }
  });
});
