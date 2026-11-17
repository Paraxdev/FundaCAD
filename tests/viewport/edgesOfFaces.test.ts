import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Viewport } from "../../src/viewport/viewport";
import type { EdgeRef } from "../../src/viewport/edgeLines";

type P = [number, number, number];

// body1 is a 10 x 6 x 4 block with its corner at (3, -2, 5): face 0 is its top (z = 9), face 1 its x = 3 wall. The
// top's far edge is the boundary of a fillet, so the tangent edge setting hides it. body2 touches the top with an
// edge of its own.
const edge = (id: string, body: string, points: P[], smooth = false) =>
  ({ id, body, points, smooth }) as unknown as EdgeRef;
const top = [
  edge("t1", "body1", [
    [3, -2, 9],
    [13, -2, 9],
  ]),
  edge("t3", "body1", [
    [13, 4, 9],
    [3, 4, 9],
  ]),
  edge("t4", "body1", [
    [3, 4, 9],
    [3, -2, 9],
  ]),
];
const tangent = edge(
  "t2",
  "body1",
  [
    [13, -2, 9],
    [13, 4, 9],
  ],
  true,
);
const wallOnly = edge("w1", "body1", [
  [3, -2, 5],
  [3, -2, 9],
]);
const wallBottom = edge("w2", "body1", [
  [3, 4, 5],
  [3, -2, 5],
]);
const stranger = edge("s1", "body2", [
  [5, 0, 9],
  [9, 0, 9],
]);

function block() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([3, -2, 9, 13, -2, 9, 13, 4, 9, 3, 4, 9, 3, -2, 5, 3, 4, 5], 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 5, 0, 5, 4]);
  const mesh = new THREE.Mesh(geometry);
  const faceTriangles = new Map([
    [0, [0, 1]],
    [1, [2, 3]],
  ]);
  return { id: "body1", faceStart: 0, faceCount: 2, faceTriangles, mesh };
}

function viewport(withModel = true) {
  const v = Object.create(Viewport.prototype) as Viewport;
  const all = [...top, tangent, wallOnly, wallBottom, stranger];
  const drawn = all.filter((e) => !e.smooth);
  const second = { id: "body2", faceStart: 2, faceCount: 1, faceTriangles: new Map(), mesh: new THREE.Mesh() };
  Object.assign(v, {
    model: withModel
      ? {
          bodies: [block(), second],
          edges: all,
          box: new THREE.Box3(new THREE.Vector3(3, -2, 5), new THREE.Vector3(13, 4, 9)),
        }
      : null,
    picker: { visibleEdges: () => drawn },
    highlighter: { getSelectedFaces: () => [0] },
  });
  return v;
}

const ids = (edges: EdgeRef[]) => edges.map((e) => e.id).sort();

describe("edgesOfFaces", () => {
  it("gives the drawn edges on a face, none of another body", () => {
    expect(ids(viewport().edgesOfFaces([0]))).toEqual(["t1", "t3", "t4"]);
  });

  it("keeps a tangent edge hidden by the edge setting when all is asked for", () => {
    expect(ids(viewport().edgesOfFaces([0], { all: true }))).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("gives each face its own edges and shares none twice", () => {
    expect(ids(viewport().edgesOfFaces([0, 1], { all: true }))).toEqual(["t1", "t2", "t3", "t4", "w1", "w2"]);
    expect(ids(viewport().edgesOfFaces([1], { all: true }))).toEqual(["t4", "w1", "w2"]);
  });

  it("gives nothing for no face, an unknown face or no model", () => {
    expect(viewport().edgesOfFaces([])).toEqual([]);
    expect(viewport().edgesOfFaces([7], { all: true })).toEqual([]);
    expect(viewport(false).edgesOfFaces([0], { all: true })).toEqual([]);
  });

  it("is what edgesOfSelectedFaces reads for the selected faces", () => {
    expect(ids(viewport().edgesOfSelectedFaces())).toEqual(["t1", "t3", "t4"]);
  });
});
