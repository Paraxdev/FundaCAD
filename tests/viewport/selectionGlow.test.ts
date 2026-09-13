import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { makeSelectionGlow } from "../../src/viewport/selectionGlow";
import { Highlighter } from "../../src/viewport/highlight";
import type { ModelView } from "../../src/viewport/render";

describe("selection glow", () => {
  it("a new highlighter takes off the glows an old one left on a reused body", () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.Mesh(geometry);
    const keep = new THREE.Object3D();
    mesh.add(makeSelectionGlow(geometry, "select"), makeSelectionGlow(geometry, "hover"), keep);
    new Highlighter({ bodies: [{ id: "b1", mesh }] } as unknown as ModelView);
    expect(mesh.children).toEqual([keep]);
  });
});
