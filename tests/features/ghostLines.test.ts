// Fillet members draw as one line object: one Line2 per member made each frame of a 5,000 member preview twice as slow.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GhostLines } from "../../src/features/ghostLines";

function host() {
  const scene: THREE.Object3D[] = [];
  return {
    scene,
    domElement: { clientWidth: 800, clientHeight: 600 } as HTMLElement,
    addToScene: (o: THREE.Object3D) => void scene.push(o),
    removeFromScene: (o: THREE.Object3D) => {
      const i = scene.indexOf(o);
      if (i >= 0) scene.splice(i, 1);
    },
  };
}

const edge = (i: number): [number, number, number][] => [
  [i, 0, 0],
  [i, 1, 0],
  [i, 2, 0],
];

const geometry = (o: THREE.Object3D) => (o as THREE.Mesh).geometry;
const segments = (o: THREE.Object3D) => geometry(o).getAttribute("instanceStart").count;
const colourAt = (o: THREE.Object3D, segment: number) => {
  const a = geometry(o).getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute;
  return new THREE.Color(a.getX(segment), a.getY(segment), a.getZ(segment)).getHex();
};
const near = (a: number, b: number) => [16, 8, 0].every((s) => Math.abs(((a >> s) & 0xff) - ((b >> s) & 0xff)) <= 2);

describe("fillet ghost lines", () => {
  it("draw 5,000 members as one object on top of the model", () => {
    const h = host();
    const lines = new GhostLines(h);
    for (let i = 0; i < 5000; i++) lines.add(edge(i), 0x3fa9f5);
    lines.sync();
    expect(h.scene.length).toBe(1);
    expect(h.scene[0]!.renderOrder).toBe(998);
    expect(segments(h.scene[0]!)).toBe(10000);
    expect(near(colourAt(h.scene[0]!, 9999), 0x3fa9f5)).toBe(true);
  });

  it("recolour one member in place without rebuilding", () => {
    const h = host();
    const lines = new GhostLines(h);
    const slots = [0, 1, 2, 3].map((i) => lines.add(edge(i), 0x3fa9f5));
    lines.sync();
    const drawn = h.scene[0]!;
    const geo = geometry(drawn);
    lines.setColor(slots[2]!, 0xff4d6d);
    expect(h.scene[0]).toBe(drawn);
    expect(geometry(drawn)).toBe(geo);
    expect([3, 4, 5, 6].map((s) => near(colourAt(drawn, s), 0xff4d6d))).toEqual([false, true, true, false]);
  });

  it("drop a removed member on sync and leave the scene when empty", () => {
    const h = host();
    const lines = new GhostLines(h);
    const a = lines.add(edge(0), 0x3fa9f5);
    const b = lines.add(edge(1), 0xff4d6d);
    lines.sync();
    lines.remove(a);
    lines.setColor(a, 0x00ff00);
    lines.sync();
    expect(h.scene.length).toBe(1);
    expect(segments(h.scene[0]!)).toBe(2);
    expect(near(colourAt(h.scene[0]!, 0), 0xff4d6d)).toBe(true);
    lines.remove(b);
    lines.sync();
    expect(h.scene.length).toBe(0);
  });

  it("leave the scene on dispose", () => {
    const h = host();
    const lines = new GhostLines(h);
    lines.add(edge(0), 0x3fa9f5);
    lines.sync();
    lines.dispose();
    expect(h.scene.length).toBe(0);
  });
});
