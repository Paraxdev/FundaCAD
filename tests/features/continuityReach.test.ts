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

  it("takes the lowest reach of the picked edges, absent counting as 3", () => {
    expect(pickedReach([])).toBe(3);
    expect(pickedReach([{}, { reach: 3 }])).toBe(3);
    expect(pickedReach([{}, { reach: 1 }])).toBe(1);
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

  it("unpacks each edge's reach from a binary frame", () => {
    const pts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0]);
    const edges = expandPackedEdges(pts, new Uint32Array([2, 2]), "b1", [], [[1, 1]]);
    expect(edges[0]!.reach).toBeUndefined();
    expect(edges[1]!.reach).toBe(1);
  });
});
