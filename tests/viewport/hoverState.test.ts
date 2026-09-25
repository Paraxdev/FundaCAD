// A plain pointer move draws a frame only when what hover lights changed, which
// the viewport reads off these snapshots.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Highlighter, sameHover } from "../../src/viewport/highlight";
import type { BodyMesh, ModelView } from "../../src/viewport/render";

function view(): ModelView {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const n = geometry.getAttribute("position").count;
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const mesh = new THREE.Mesh(geometry);
  const tris = geometry.getIndex()!.count / 3;
  const faceIds = Array.from({ length: tris }, (_, t) => Math.floor(t / 2));
  const faceTriangles = new Map<number, number[]>();
  faceIds.forEach((f, t) => faceTriangles.set(f, [...(faceTriangles.get(f) ?? []), t]));
  const body = {
    id: "b1", name: "Body1", faceStart: 0, faceCount: 6, mesh, faceIds,
    baseColors: new Float32Array(n * 3), faceTriangles,
  } as unknown as BodyMesh;
  return { bodies: [body], edges: [] } as unknown as ModelView;
}

describe("hover state", () => {
  it("reads the same after the viewport clears and relights the same face", () => {
    const h = new Highlighter(view());
    h.hoverFaceRun([1, 2]);
    const before = h.hoverState();
    h.clearHover();
    h.hoverFaceRun([1, 2]);
    expect(sameHover(before, h.hoverState())).toBe(true);
  });

  it("reads different when the cursor lands on another face, a body or nothing", () => {
    const h = new Highlighter(view());
    h.hoverFace(1);
    const onFace = h.hoverState();
    h.hoverFace(2);
    expect(sameHover(onFace, h.hoverState())).toBe(false);
    const onOther = h.hoverState();
    h.clearHover();
    h.hoverBody("b1");
    expect(sameHover(onOther, h.hoverState())).toBe(false);
    const onBody = h.hoverState();
    h.hoverBody(null);
    expect(sameHover(onBody, h.hoverState())).toBe(false);
  });

  it("treats no highlighter on either side as unchanged", () => {
    expect(sameHover(undefined, undefined)).toBe(true);
    expect(sameHover(undefined, new Highlighter(view()).hoverState())).toBe(false);
  });
});
