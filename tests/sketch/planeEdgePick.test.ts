import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  edgeProbePoint,
  isExactPlaneEdge,
  meshBodyIds,
  pickPlaneEdge,
  planeEdgeChain,
} from "../../src/sketch/planeEdgePick";
import { planeEdges } from "../../src/sketch/faceFootprint";
import { SketchPlane } from "../../src/sketch/plane";
import type { Feature } from "../../src/types";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const circle = (r: number, n = 32) =>
  Array.from({ length: n + 1 }, (_x, i) => v(r * Math.cos((i / n) * Math.PI * 2), r * Math.sin((i / n) * Math.PI * 2)));
/** a 40 x 30 face outline, one polyline per B-rep edge */
const rim = () => [
  [v(-20, -15), v(20, -15)],
  [v(20, -15), v(20, 15)],
  [v(20, 15), v(-20, 15)],
  [v(-20, 15), v(-20, -15)],
];

describe("pickPlaneEdge", () => {
  it("finds the edge under the cursor within the tolerance", () => {
    expect(pickPlaneEdge(rim(), v(20.3, 2), 0.5)).toBe(1);
    expect(pickPlaneEdge(rim(), v(0, 0), 0.5)).toBe(-1);
  });

  it("takes the nearer of two edges", () => {
    expect(pickPlaneEdge(rim(), v(19.8, 14.9), 0.5)).toBe(2);
  });
});

describe("planeEdgeChain", () => {
  it("walks a face outline into its whole loop, clicked edge first", () => {
    const chain = planeEdgeChain(rim(), 2, 1e-3);
    expect(chain[0]).toBe(2);
    expect([...chain].sort()).toEqual([0, 1, 2, 3]);
  });

  it("keeps a hole's loop apart from the outline around it", () => {
    const polys = [...rim(), circle(5)];
    expect(planeEdgeChain(polys, 4, 1e-3)).toEqual([4]);
    expect(planeEdgeChain(polys, 0, 1e-3)).toHaveLength(4);
  });

  it("answers with the clicked edge alone at a junction", () => {
    const polys = [...rim(), [v(20, 15), v(30, 25)]];
    expect(planeEdgeChain(polys, 0, 1e-3)).toEqual([0]);
  });

  it("follows an open path to both of its ends", () => {
    const polys = [[v(0, 0), v(10, 0)], [v(10, 0), v(10, 10)], [v(10, 10), v(0, 10)]];
    expect([...planeEdgeChain(polys, 1, 1e-3)].sort()).toEqual([0, 1, 2]);
  });
});

describe("edgeProbePoint", () => {
  it("lands mid-segment, never on a straight edge's corner", () => {
    expect(edgeProbePoint([[0, 0, 5], [10, 0, 5]])).toEqual([5, 0, 5]);
  });

  it("stays on a sampled curve's middle segment", () => {
    expect(edgeProbePoint([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]])).toEqual([1.5, 0, 0]);
  });

  it("has nothing to offer for an empty edge", () => {
    expect(edgeProbePoint([])).toBeNull();
  });
});

describe("mesh bodies", () => {
  const features = [
    { id: "imp", type: "import", format: "stl", name: "part", geom: "h" },
    { id: "stp", type: "import", format: "step", name: "cad", geom: "h" },
    { id: "ext", type: "extrude", sketch: "s", distance: 5, operation: "new" },
  ] as Feature[];
  const bodies = [
    { id: "mesh", name: "a", faceStart: 0, faceCount: 2, faceOwners: ["imp", "ext"] },
    { id: "step", name: "b", faceStart: 2, faceCount: 1, faceOwners: ["stp"] },
    { id: "made", name: "c", faceStart: 3, faceCount: 1, faceOwners: ["ext"] },
  ];

  it("marks a body carrying faces from a mesh file, not a STEP or a modelled one", () => {
    expect([...meshBodyIds(bodies, features)]).toEqual(["mesh"]);
  });

  it("offers a curved edge on a mesh body but never its straight facet sides", () => {
    const mesh = new Set(["mesh"]);
    expect(isExactPlaneEdge({ body: "mesh", points: [[0, 0, 0], [1, 0, 0]] }, mesh)).toBe(false);
    expect(isExactPlaneEdge({ body: "mesh", points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]] }, mesh)).toBe(true);
    expect(isExactPlaneEdge({ body: "made", points: [[0, 0, 0], [1, 0, 0]] }, mesh)).toBe(true);
  });

  it("never offers an edge with no body to project it from", () => {
    expect(isExactPlaneEdge({ body: undefined, points: [[0, 0, 0], [1, 0, 0]] }, new Set())).toBe(false);
  });
});

describe("planeEdges", () => {
  it("keeps the source edge beside each in-plane polyline", () => {
    const plane = new SketchPlane({ origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] });
    const top = { id: "t", points: [[0, 0, 5], [10, 0, 5]] as [number, number, number][] };
    const side = { id: "s", points: [[0, 0, 5], [0, 0, 0]] as [number, number, number][] };
    const out = planeEdges([top, side], plane, 100);
    expect(out).toHaveLength(1);
    expect(out[0]!.edge).toBe(top);
    expect(out[0]!.poly.map((p) => [p.x, p.y])).toEqual([[0, 0], [10, 0]]);
  });
});
