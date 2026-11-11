// The outline a tool draws over its opaque preview: two passes from one set of polylines, an accent for an add and the
// error colour for a cut, and nothing in it can be picked.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { GhostLines } from "../../src/features/ghostLines";
import { ToolOutline } from "../../src/features/toolOutline";
import { edgeSelectColor } from "../../src/viewport/highlight";
import type { Polyline } from "../../src/features/sweepOutline";

function host() {
  const scene: THREE.Object3D[] = [];
  let renders = 0;
  return {
    scene,
    renders: () => renders,
    domElement: { clientWidth: 800, clientHeight: 600 } as HTMLElement,
    addToScene: (o: THREE.Object3D) => void scene.push(o),
    removeFromScene: (o: THREE.Object3D) => {
      const i = scene.indexOf(o);
      if (i >= 0) scene.splice(i, 1);
    },
    requestRender: () => void renders++,
  };
}

const ring = (z: number): Polyline => [
  [3, 2, z],
  [9, 2, z],
  [9, 7, z],
  [3, 7, z],
  [3, 2, z],
];
const side: Polyline = [
  [3, 2, 0],
  [3, 2, 5],
];
const lines = [ring(0), ring(5), side];

const material = (o: THREE.Object3D) => (o as THREE.Mesh).material as LineMaterial;
const count = (o: THREE.Object3D) => (o as THREE.Mesh).geometry.getAttribute("instanceStart").count;
const colourAt = (o: THREE.Object3D, segment: number) => {
  const a = (o as THREE.Mesh).geometry.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute;
  return new THREE.Color(a.getX(segment), a.getY(segment), a.getZ(segment)).getHex();
};
const near = (a: number, b: number) => [16, 8, 0].every((s) => Math.abs(((a >> s) & 0xff) - ((b >> s) & 0xff)) <= 2);

function ray() {
  const cam = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 100);
  cam.position.set(6, 4.5, 20);
  cam.lookAt(6, 4.5, 0);
  cam.updateMatrixWorld();
  const rc = new THREE.Raycaster();
  rc.camera = cam;
  const on = new THREE.Vector3(6, 2, 0).project(cam);
  rc.setFromCamera(new THREE.Vector2(on.x, on.y), cam);
  return rc;
}

describe("ToolOutline", () => {
  it("draws two passes, a depth tested full one and a faint one through the body", () => {
    const h = host();
    const o = new ToolOutline(h);
    o.show(lines, { cut: false });
    expect(h.scene).toHaveLength(2);
    const [front, through] = h.scene.map(material) as [LineMaterial, LineMaterial];
    expect([front.depthTest, front.opacity]).toEqual([true, 1]);
    expect([through.depthTest, through.opacity]).toEqual([false, 0.35]);
    expect(h.scene.map(count)).toEqual([4 + 4 + 1, 4 + 4 + 1]);
    expect(o.segments).toBe(9);
  });

  it("paints an add in the accent and a cut in the error colour, the cut through pass a little stronger", () => {
    const h = host();
    const o = new ToolOutline(h);
    o.show(lines, { cut: false });
    expect(o.color).toBe(edgeSelectColor());
    expect(near(colourAt(h.scene[0]!, 0), edgeSelectColor())).toBe(true);
    expect(material(h.scene[1]!).opacity).toBe(0.35);

    o.show(lines, { cut: true });
    expect(o.color).not.toBe(edgeSelectColor());
    expect(near(colourAt(h.scene[0]!, 8), o.color)).toBe(true);
    expect(near(colourAt(h.scene[1]!, 0), o.color)).toBe(true);
    expect(material(h.scene[1]!).opacity).toBe(0.6);
    expect(h.scene).toHaveLength(2);

    o.show(lines, { cut: false });
    expect(material(h.scene[1]!).opacity).toBe(0.35);
    expect(h.scene).toHaveLength(2);
  });

  it("follows new polylines in place, nothing of the old ones stays", () => {
    const h = host();
    const o = new ToolOutline(h);
    o.show(lines, { cut: false });
    o.show([ring(2)], { cut: false });
    expect(h.scene).toHaveLength(2);
    expect(h.scene.map(count)).toEqual([4, 4]);
    expect(o.segments).toBe(4);
  });

  it("cannot be hit by a ray, where the same lines drawn plainly can", () => {
    const h = host();
    const plain = new GhostLines(h, { width: 1.8 });
    plain.add(ring(0), 0xffffff);
    plain.sync();
    const rc = ray();
    const hitsPlain = rc.intersectObjects(h.scene, false);
    expect(hitsPlain.length).toBeGreaterThan(0);
    plain.dispose();

    const o = new ToolOutline(h);
    o.show(lines, { cut: false });
    expect(h.scene).toHaveLength(2);
    expect(rc.intersectObjects(h.scene, false)).toEqual([]);
  });

  it("hides on no polylines and on hide, then shows again", () => {
    const h = host();
    const o = new ToolOutline(h);
    o.hide();
    expect(h.scene).toEqual([]);
    o.show(lines, { cut: false });
    o.show([], { cut: false });
    expect(h.scene).toEqual([]);
    expect(o.segments).toBe(0);
    o.show(lines, { cut: false });
    expect(h.scene).toHaveLength(2);
    o.hide();
    expect(h.scene).toEqual([]);
    expect(o.segments).toBe(0);
    o.show([side], { cut: true });
    expect(h.scene.map(count)).toEqual([1, 1]);
  });

  it("dispose takes both objects off the scene and a second outline on the same host is separate", () => {
    const h = host();
    const a = new ToolOutline(h);
    const b = new ToolOutline(h);
    a.show(lines, { cut: false });
    b.show([side], { cut: false });
    expect(h.scene).toHaveLength(4);
    a.dispose();
    expect(h.scene).toHaveLength(2);
    expect(h.scene.map(count)).toEqual([1, 1]);
    b.dispose();
    expect(h.scene).toEqual([]);
    a.dispose();
    expect(h.scene).toEqual([]);
  });
});
