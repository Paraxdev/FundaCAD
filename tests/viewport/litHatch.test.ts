// A face a Geometry row lights is hatched, a selected face keeps its tint, so "looking at" and "picked" never read
// the same in any theme.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Highlighter } from "../../src/viewport/highlight";
import { HATCH, LIT_HATCH_NAME } from "../../src/viewport/litHatch";
import type { BodyMesh, ModelView } from "../../src/viewport/render";

function rig() {
  const geometry = new THREE.BoxGeometry(4, 4, 4);
  const n = geometry.getAttribute("position").count;
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.6), 3));
  const mesh = new THREE.Mesh(geometry);
  const tris = geometry.getIndex()!.count / 3;
  const faceTriangles = new Map<number, number[]>();
  for (let t = 0; t < tris; t++) faceTriangles.set(t >> 1, [...(faceTriangles.get(t >> 1) ?? []), t]);
  const body = {
    id: "b1",
    name: "Body1",
    faceStart: 0,
    faceCount: 6,
    mesh,
    faceIds: Array.from({ length: tris }, (_, t) => t >> 1),
    baseColors: new Float32Array(n * 3).fill(0.6),
    faceTriangles,
  } as unknown as BodyMesh;
  const h = new Highlighter({ bodies: [body], edges: [] } as unknown as ModelView);
  const names = () => {
    h.settle();
    return mesh.children.map((c) => c.name).sort();
  };
  const hatch = () => mesh.children.find((c) => c.name === LIT_HATCH_NAME) as THREE.Mesh | undefined;
  return { h, mesh, names, hatch };
}

describe("lit face hatch", () => {
  it("hatches a lit face and leaves it untinted", () => {
    const r = rig();
    r.h.litFaceRun([1]);
    expect(r.names()).toEqual([LIT_HATCH_NAME]);
    expect(r.h.hoverState().faces).toEqual([]);
  });

  it("tints a selected face and does not hatch it", () => {
    const r = rig();
    r.h.selectFace(1);
    expect(r.names()).toEqual(["face-select-overlay"]);
  });

  it("gives a lit selected face both the tint and the hatch", () => {
    const r = rig();
    r.h.selectFace(1);
    r.h.litFaceRun([1]);
    expect(r.names()).toEqual([LIT_HATCH_NAME, "face-select-overlay"]);
  });

  it("drops the hatch when the row goes out and keeps the selection", () => {
    const r = rig();
    r.h.selectFace(1);
    r.h.litFaceRun([1]);
    r.h.litFaceRun([]);
    expect(r.names()).toEqual(["face-select-overlay"]);
  });

  it("draws the hatch depth tested, without depth write, on the front side, in front of the body", () => {
    const r = rig();
    r.h.litFaceRun([1]);
    const m = r.hatch()!.material as THREE.MeshBasicMaterial;
    expect(m.depthTest).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.polygonOffset).toBe(true);
    expect(m.polygonOffsetFactor).toBeLessThan(0);
    expect(m.side).toBe(THREE.FrontSide);
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBe(HATCH.opacity);
  });

  it("strokes the stripes in another colour over a selected face than over a bare one", () => {
    const bare = rig();
    bare.h.litFaceRun([1]);
    const picked = rig();
    picked.h.selectFace(1);
    picked.h.litFaceRun([1]);
    picked.h.settle();
    const colour = (m: THREE.Mesh) => [...(m.geometry.getAttribute("color").array as Float32Array).slice(0, 3)];
    bare.h.settle();
    expect(colour(picked.hatch()!)).not.toEqual(colour(bare.hatch()!));
  });

  it("fixes the stripes to the surface, the same coordinate for the same point wherever the camera is", () => {
    const r = rig();
    r.h.litFaceRun([1]);
    r.h.settle();
    const geo = r.hatch()!.geometry;
    const s = geo.getAttribute("hatch");
    const p = geo.getAttribute("position");
    expect(s.count).toBe(p.count);
    // A face spans many stripes, so a lit face never reads as one flat wash.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < s.count; i++) {
      lo = Math.min(lo, s.getX(i));
      hi = Math.max(hi, s.getX(i));
    }
    expect(hi - lo).toBeGreaterThan(8);
  });
});
