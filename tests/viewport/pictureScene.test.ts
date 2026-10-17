import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { hideForPicture, markInPicture } from "../../src/viewport/pictureScene";
import { makeFaceHoverOverlay, makeSelectionGlow } from "../../src/viewport/selectionGlow";
import { Highlighter } from "../../src/viewport/highlight";
import type { EdgeRef, ModelView } from "../../src/viewport/render";

function scene() {
  const s = new THREE.Scene();
  const model = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const body = new THREE.Mesh(geometry);
  const glow = makeSelectionGlow(geometry, "select");
  const hover = makeFaceHoverOverlay(new Float32Array(9), new THREE.Color(0xff0000));
  body.add(glow, hover);
  const edges = new THREE.Object3D();
  model.add(body, edges);
  const key = new THREE.DirectionalLight();
  const emitters = markInPicture(new THREE.Group());
  emitters.add(new THREE.PointLight());
  const caps = markInPicture(new THREE.Group());
  const gizmo = new THREE.Group();
  const grid = new THREE.Group();
  const sketch = new THREE.Group();
  sketch.visible = false;
  s.add(key, model, emitters, caps, gizmo, grid, sketch);
  return { s, model, body, glow, hover, edges, key, emitters, caps, gizmo, grid, sketch };
}

describe("a picture draws the model only", () => {
  it("hides the selection glow, the hovered face and every overlay, keeps the model and its light", () => {
    const t = scene();
    const restore = hideForPicture(t.s, t.model);
    for (const o of [t.model, t.body, t.edges, t.key, t.emitters, t.caps]) expect(o.visible).toBe(true);
    for (const o of [t.glow, t.hover, t.gizmo, t.grid, t.sketch]) expect(o.visible).toBe(false);
    restore();
    for (const o of [t.glow, t.hover, t.gizmo, t.grid]) expect(o.visible).toBe(true);
    expect(t.sketch.visible).toBe(false);
  });
});

describe("selection paint stays out of a picture", () => {
  function view() {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const n = geometry.getAttribute("position").count;
    const base = new Float32Array(n * 3).fill(0.5);
    geometry.setAttribute("color", new THREE.BufferAttribute(base.slice(), 3));
    // BoxGeometry: 6 sides of 2 triangles each, one face per side
    const faceTriangles = new Map<number, number[]>();
    for (let f = 0; f < 6; f++) faceTriangles.set(f, [f * 2, f * 2 + 1]);
    const faceIds = Array.from({ length: 12 }, (_, t) => Math.floor(t / 2));
    const body = { id: "b1", mesh: new THREE.Mesh(geometry), faceStart: 0, faceCount: 6, faceTriangles, faceIds, baseColors: base };
    return { v: { bodies: [body] } as unknown as ModelView, color: geometry.getAttribute("color") as THREE.BufferAttribute };
  }
  function edge() {
    const colours: number[] = [];
    const draw = {
      setColor: (_s: number, c: THREE.Color) => colours.push(c.getHex()),
      setIdleColor: (_s: number, c: THREE.Color) => colours.push(c.getHex()),
    };
    return { e: { draw, slot: 0 } as unknown as EdgeRef, last: () => colours.at(-1) };
  }
  const faceColour = (attr: THREE.BufferAttribute, f: number, index: THREE.BufferAttribute) =>
    [attr.getX(index.getX(f * 6)), attr.getY(index.getX(f * 6)), attr.getZ(index.getX(f * 6))];

  it("draws selected and hovered faces and edges plain during the picture and tinted after", () => {
    const { v, color } = view();
    const index = v.bodies[0]!.mesh.geometry.getIndex()!;
    const h = new Highlighter(v);
    const sel = edge();
    const hov = edge();
    h.selectFace(1);
    h.hoverFace(2);
    h.selectEdge(sel.e);
    h.hoverEdge(hov.e);
    const selected = faceColour(color, 1, index);
    const hovered = faceColour(color, 2, index);
    const selEdge = sel.last();
    const hovEdge = hov.last();
    expect(selected).not.toEqual([0.5, 0.5, 0.5]);

    let during: number[][] = [];
    let edgesDuring: (number | undefined)[] = [];
    h.withoutSelectionPaint(() => {
      during = [faceColour(color, 1, index), faceColour(color, 2, index)];
      edgesDuring = [sel.last(), hov.last()];
    });
    expect(during).toEqual([[0.5, 0.5, 0.5], [0.5, 0.5, 0.5]]);
    expect(edgesDuring).not.toContain(selEdge);
    expect(edgesDuring).not.toContain(hovEdge);

    expect(faceColour(color, 1, index)).toEqual(selected);
    expect(faceColour(color, 2, index)).toEqual(hovered);
    expect([sel.last(), hov.last()]).toEqual([selEdge, hovEdge]);
    expect(h.getSelectedFaces()).toEqual([1]);
  });
});
