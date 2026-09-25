// The face hover overlay on a selected body copies the hovered triangles into a
// geometry of its own. Every rebuild replaces the Highlighter and reuses the body
// mesh, so an overlay left on the mesh or cached by the old highlighter leaked one
// geometry per rebuild (NV3R-2).
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Highlighter } from "../../src/viewport/highlight";
import type { BodyMesh, ModelView } from "../../src/viewport/render";

function view(): { view: ModelView; mesh: THREE.Mesh } {
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
  return { view: { bodies: [body] } as unknown as ModelView, mesh };
}

/** Live overlay geometries: every one ever made, minus the disposed ones. */
function tracker(mesh: THREE.Mesh) {
  const live = new Set<THREE.BufferGeometry>();
  return {
    live,
    note() {
      for (const c of mesh.children) {
        if (c.name !== "face-hover-overlay") continue;
        const g = (c as THREE.Mesh).geometry;
        if (live.has(g)) continue;
        live.add(g);
        g.addEventListener("dispose", () => live.delete(g));
      }
    },
  };
}

describe("face hover overlay lifetime", () => {
  it("draws above the glow only while a face of a selected body is hovered", () => {
    const { view: v, mesh } = view();
    const h = new Highlighter(v);
    h.hoverFace(0);
    expect(mesh.children.filter((c) => c.name === "face-hover-overlay")).toHaveLength(0);
    h.toggleSelectBody("b1");
    expect(mesh.children.filter((c) => c.name === "face-hover-overlay")).toHaveLength(1);
    h.hoverFace(null);
    expect(mesh.children.filter((c) => c.name === "face-hover-overlay")).toHaveLength(0);
  });

  it("does not leak a geometry per rebuild, shown or cached when the rebuild lands", () => {
    const { view: v, mesh } = view();
    const t = tracker(mesh);
    let h: Highlighter | null = null;
    for (let rebuild = 0; rebuild < 6; rebuild++) {
      // what viewport.setModel does with a reused body
      h?.dispose();
      h = new Highlighter(v);
      h.toggleSelectBody("b1");
      h.hoverFace(rebuild % 3);
      t.note();
      // every other rebuild lands while the overlay is hidden and only cached
      if (rebuild % 2) h.hoverFace(null);
    }
    expect(t.live.size).toBeLessThanOrEqual(1);
    h!.dispose();
    expect(t.live.size).toBe(0);
  });

  it("a new highlighter frees an overlay the old one left on the mesh without being disposed", () => {
    const { view: v, mesh } = view();
    const t = tracker(mesh);
    const old = new Highlighter(v);
    old.toggleSelectBody("b1");
    old.hoverFace(1);
    t.note();
    expect(t.live.size).toBe(1);
    new Highlighter(v);
    expect(t.live.size).toBe(0);
  });
});
