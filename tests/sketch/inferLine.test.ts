// Horizontal/vertical auto-constrain, and the deliberate offset it used to eat.

import { describe, expect, it } from "vitest";
import { INFER_TOL_DEG, inferLineDirection, onLattice } from "../../src/sketch/inferLine";

const infer = (x1: number, y1: number, x2: number, y2: number, step = 0) =>
  inferLineDirection(x1, y1, x2, y2, step);

describe("inferLineDirection", () => {
  describe("with no grid to go on", () => {
    it("guesses horizontal and vertical within the tolerance", () => {
      expect(infer(0, 0, 100, 0)).toBe("horizontal");
      expect(infer(0, 0, 0, 100)).toBe("vertical");
      expect(infer(0, 0, 100, 2)).toBe("horizontal"); // 1.15 deg
      expect(infer(0, 0, 2, 100)).toBe("vertical");
    });

    it("leaves a line that is plainly diagonal alone", () => {
      expect(infer(0, 0, 100, 100)).toBeNull();
      expect(infer(0, 0, 100, 10)).toBeNull(); // 5.7 deg
    });

    it("reads a line drawn in either direction the same way", () => {
      expect(infer(100, 0, 0, 0)).toBe("horizontal");
      expect(infer(0, 100, 0, 0)).toBe("vertical");
      expect(infer(100, 2, 0, 0)).toBe("horizontal");
    });

    it("uses the stated tolerance and not one either side of it", () => {
      const just = Math.tan((INFER_TOL_DEG - 0.01) * Math.PI / 180) * 100;
      const past = Math.tan((INFER_TOL_DEG + 0.01) * Math.PI / 180) * 100;
      expect(infer(0, 0, 100, just)).toBe("horizontal");
      expect(infer(0, 0, 100, past)).toBeNull();
    });
  });

  describe("when the grid has already said what was meant", () => {
    const STEP = 5;

    it("keeps a deliberate one-cell rise", () => {
      // The defect. Both ends are on the lattice and one cell apart in y, which
      // is 1.43 degrees over this length: inside the tolerance, so the guess
      // used to flatten the line and silently discard the 5mm the user had
      // snapped to.
      expect(infer(0, 0, 200, 5, STEP)).toBeNull();
      expect(infer(0, 0, 200, 5)).toBe("horizontal"); // what it did without the grid
    });

    it("still records an exactly horizontal or vertical line", () => {
      expect(infer(0, 10, 200, 10, STEP)).toBe("horizontal");
      expect(infer(15, 0, 15, 200, STEP)).toBe("vertical");
    });

    it("says nothing about a line the grid drew diagonally", () => {
      expect(infer(0, 0, 5, 5, STEP)).toBeNull();
      expect(infer(0, 0, 100, 25, STEP)).toBeNull();
    });

    it("falls back to the guess when an endpoint is off the lattice", () => {
      // Ctrl suppresses snapping for one point, or a point snapped to another
      // entity rather than to the grid. There is no statement of intent then,
      // so the old rule is the best available.
      expect(infer(0, 0, 200, 4.3, STEP)).toBe("horizontal");
      expect(infer(0.7, 0, 200, 5, STEP)).toBe("horizontal");
    });

    it("falls back when grid snapping is off entirely", () => {
      expect(infer(0, 0, 200, 5, 0)).toBe("horizontal");
    });

    it("works at any lattice, since the lattice follows the zoom", () => {
      for (const step of [0.01, 0.1, 1, 5, 20, 50]) {
        expect(infer(0, 0, 40 * step, step, step), `step ${step}`).toBeNull();
        expect(infer(0, step, 40 * step, step, step), `step ${step}`).toBe("horizontal");
      }
    });

    it("never records more than the old rule would have", () => {
      // The safety property: a grid answer of "horizontal" means the endpoints
      // share a y exactly, which is 0 degrees and always inside the tolerance.
      // So this change can only ever record FEWER constraints, and cannot
      // introduce one that fights an existing constraint.
      const cases: [number, number, number, number][] = [
        [0, 0, 100, 0], [0, 0, 0, 100], [5, 5, 105, 5], [10, 0, 10, 60],
        [0, 0, 200, 5], [0, 0, 5, 5], [0, 0, 100, 25], [0, 0, 35, 5],
      ];
      for (const [x1, y1, x2, y2] of cases) {
        const withGrid = infer(x1, y1, x2, y2, STEP);
        if (withGrid !== null) {
          expect(infer(x1, y1, x2, y2), `${[x1, y1, x2, y2]}`).toBe(withGrid);
        }
      }
    });
  });

  it("refuses a degenerate line rather than constraining a point", () => {
    // Both ends on the same lattice point. Calling that horizontal AND vertical
    // is a coin toss, and either constraint on a zero-length line is noise the
    // solver then has to carry.
    expect(infer(0, 0, 0, 0, 5)).toBeNull();
    expect(infer(10, 10, 10, 10, 5)).toBeNull();
  });

  it("survives coordinates that are not numbers", () => {
    expect(inferLineDirection(NaN, 0, 1, 0, 5)).toBeNull();
    expect(inferLineDirection(0, 0, Infinity, 0, 5)).toBeNull();
  });
});

describe("onLattice", () => {
  it("accepts multiples and rejects points between them", () => {
    expect(onLattice(0, 5)).toBe(true);
    expect(onLattice(-15, 5)).toBe(true);
    expect(onLattice(2.5, 5)).toBe(false);
  });

  it("scales its tolerance with the step", () => {
    // The lattice is 0.01mm at one zoom and 50mm at another. A fixed epsilon is
    // uselessly tight at one end and meaningless at the other.
    expect(onLattice(0.03, 0.01)).toBe(true);
    expect(onLattice(0.005, 0.01)).toBe(false);
    expect(onLattice(150, 50)).toBe(true);
    expect(onLattice(175, 50)).toBe(false);
  });

  it("absorbs the rounding a snap leaves behind", () => {
    expect(onLattice(5 * 3 + 1e-12, 5)).toBe(true);
  });

  it("says no when there is no lattice", () => {
    expect(onLattice(5, 0)).toBe(false);
    expect(onLattice(5, NaN)).toBe(false);
    expect(onLattice(NaN, 5)).toBe(false);
  });
});
