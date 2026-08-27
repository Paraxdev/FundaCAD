import { describe, it, expect } from "vitest";
import { groundGridCells } from "../../src/viewport/scene";

// How far the ground grid runs. It was a flat 100 cells, described in the code
// as "covers several screens"; at the ~64px cell the spacing aims for, a hundred
// cells is one screen, near enough, and the grid visibly ran out a short pan
// away from what you were looking at.

const CELL_PX = 64;
/** The cell size the grid picks for a given zoom, near enough for these. */
const cellFor = (worldPerPixel: number) => worldPerPixel * CELL_PX;

describe("groundGridCells", () => {
  it("reaches past the corner of the viewport", () => {
    // Half a diagonal of cells reaches the corners exactly; the grid must run
    // further than that or its edge is inside the window.
    for (const [wpp, diag] of [[0.1, 2200], [1, 1400], [0.004, 3000]] as const) {
      const cell = cellFor(wpp);
      const corner = (wpp * diag) / 2 / cell;
      expect(groundGridCells(wpp, diag, cell), `${wpp} mm/px`).toBeGreaterThan(corner);
    }
  });

  it("is the same grid at every zoom", () => {
    // The count is what makes it look identical zoomed in and out: the cell
    // grows with the zoom and the number of them does not.
    const counts = [0.001, 0.01, 0.1, 1, 10].map((wpp) =>
      groundGridCells(wpp, 2000, cellFor(wpp)));
    expect(new Set(counts).size).toBe(1);
  });

  it("grows with the window rather than with the model", () => {
    const small = groundGridCells(0.1, 1000, cellFor(0.1));
    const large = groundGridCells(0.1, 3000, cellFor(0.1));
    expect(large).toBeGreaterThan(small);
  });

  it("does not draw the same grid for a laptop and a wide monitor", () => {
    // The control on the old constant. A hundred 64px cells is 6400px of grid
    // whatever it is shown on: five screens across on one and barely two on the
    // other, so the same build was wasteful at one size and short at the other.
    const laptop = groundGridCells(0.1, 1500, cellFor(0.1));
    const wide = groundGridCells(0.1, 4200, cellFor(0.1));
    expect(laptop).toBeLessThan(100);
    expect(wide).toBeGreaterThan(100);
  });

  it("always divides into whole major cells", () => {
    // The minor and major helpers are built from ONE span, and the major one
    // divides it by five; a count that is not a multiple of five puts the two
    // lattices on different lines.
    for (const diag of [600, 900, 1337, 2000, 3840, 100000]) {
      expect(groundGridCells(0.1, diag, cellFor(0.1)) % 5, `${diag}px`).toBe(0);
    }
  });

  it("stays inside a frame's budget however wide the window claims to be", () => {
    expect(groundGridCells(0.1, 1e9, cellFor(0.1))).toBeLessThanOrEqual(600);
  });

  it("still leaves something to orient by when the scale means nothing", () => {
    // A grid is how you tell which way up the world is. Answering "none" to a
    // degenerate zoom would take that away at exactly the wrong moment.
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(groundGridCells(bad, 2000, 10), `${bad}`).toBeGreaterThanOrEqual(40);
    }
    expect(groundGridCells(0.1, 2000, 0)).toBeGreaterThanOrEqual(40);
  });
});
