import { describe, expect, it } from "vitest";
import { continuityBlocked, continuityOf, pickedReach } from "../../src/features/continuity";
import { CONTINUITY_SEGMENTS } from "../../src/features/edgeFeatureTool";
import { expandPackedEdges } from "../../src/geometry/client";

describe("fillet continuity reach", () => {
  it("reads G3 as G3 and anything unknown as G1", () => {
    expect(continuityOf("G3")).toBe("G3");
    expect(continuityOf("G2")).toBe("G2");
    expect(continuityOf("G4")).toBe("G1");
    expect(continuityOf(undefined)).toBe("G1");
  });

  it("weighs each picked edge's curvature against the radius, as the engine's gate does", () => {
    expect(pickedReach([], 5)).toBe(3);
    expect(pickedReach([{}, { curvature: 0 }], 5)).toBe(3);
    expect(pickedReach([{}, { curvature: 1 / 15 }], 5)).toBe(1);
    expect(pickedReach([{ curvature: 1e-8 }], 10)).toBe(3);
    expect(pickedReach([{ curvature: 1e-8 }], 100)).toBe(1);
  });

  it("greys G2 and G3 out on an edge along a curved face, with the reason", () => {
    expect(continuityBlocked("G1", 1)).toBeNull();
    expect(continuityBlocked("G2", 3)).toBeNull();
    expect(continuityBlocked("G3", 3)).toBeNull();
    expect(continuityBlocked("G2", 1)).toMatch(/^G2 needs both faces flat across the edge/);
    expect(continuityBlocked("G3", 1)).toMatch(/use G1 there$/);
  });

  it("offers G3 as the third segment on key 3", () => {
    expect(CONTINUITY_SEGMENTS.map((s) => [s.id, s.key])).toEqual([
      ["G1", "1"],
      ["G2", "2"],
      ["G3", "3"],
    ]);
  });

  it("unpacks each edge's curvature from a binary frame", () => {
    const pts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0]);
    const edges = expandPackedEdges(pts, new Uint32Array([2, 2]), "b1", [], [[1, 0.0625]]);
    expect(edges[0]!.curvature).toBeUndefined();
    expect(edges[1]!.curvature).toBe(0.0625);
  });
});
