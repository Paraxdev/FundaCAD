import { describe, it, expect } from "vitest";
import { EDGE_DEPTH_FRACTION, occludedEdge } from "../../src/viewport/picking";

// A 100x100x2 plate: the thinnest thing anyone models, and so the hardest case
// for a depth tolerance to get right.
const PLATE_DIAG = Math.hypot(100, 100, 2); // ~141.4mm
const PLATE_THICKNESS = 2;

describe("occludedEdge", () => {
  it("keeps an edge that sits on the surface under the cursor", () => {
    // The ordinary hit: you clicked a visible edge, so the face behind it is at
    // essentially the same depth.
    expect(occludedEdge(50, 50, PLATE_DIAG)).toBe(false);
    expect(occludedEdge(49.999, 50, PLATE_DIAG)).toBe(false);
  });

  it("rejects an edge round the back of a THIN plate", () => {
    // The tolerance is useless if it exceeds the material it has to see through.
    // 0.28mm of slack against 2mm of plate.
    expect(occludedEdge(50 + PLATE_THICKNESS, 50, PLATE_DIAG)).toBe(true);
  });

  it("absorbs tessellation error rather than rejecting a real hit", () => {
    // A curved face's triangles sit a sagitta inside the true surface, so an edge
    // ON that surface can measure marginally behind them. Rejecting those would
    // make edges on every cylinder unpickable, a far worse bug than the one this
    // is fixing.
    const sagitta = PLATE_DIAG * EDGE_DEPTH_FRACTION * 0.5;
    expect(occludedEdge(50 + sagitta, 50, PLATE_DIAG)).toBe(false);
  });

  it("lets an edge win when there is no face under the cursor", () => {
    // Picking an edge against empty space, the silhouette grab. Nothing is in
    // front of it, so nothing can occlude it, and this must keep working or the
    // fillet tool loses its main gesture.
    expect(occludedEdge(50, null, PLATE_DIAG)).toBe(false);
    expect(occludedEdge(1e9, null, PLATE_DIAG)).toBe(false);
  });

  it("scales with the model instead of guessing in millimetres", () => {
    // The same 0.5mm gap is a real occlusion on a 6mm part and pure tessellation
    // noise on a 4-metre one. A fixed tolerance has to be wrong for one of them.
    expect(occludedEdge(10.5, 10, 6)).toBe(true);
    expect(occludedEdge(10.5, 10, 4000)).toBe(false);
  });

  it("still rejects a clearly-behind edge when the model has no size", () => {
    // An empty or degenerate view falls back to an absolute floor rather than to
    // a zero tolerance (which would call float noise an occlusion) or an infinite
    // one (which would switch the guard off).
    expect(occludedEdge(50, 50, 0)).toBe(false);
    expect(occludedEdge(60, 50, 0)).toBe(true);
    expect(occludedEdge(60, 50, Number.NaN)).toBe(true);
  });

  it("treats a missing edge depth as nothing to reject", () => {
    // pickEdge leaves this at Infinity until it has ranked a candidate. That must
    // read as "no edge", not as "an infinitely distant edge".
    expect(occludedEdge(Number.POSITIVE_INFINITY, 50, PLATE_DIAG)).toBe(false);
    expect(occludedEdge(Number.NaN, 50, PLATE_DIAG)).toBe(false);
  });
});
