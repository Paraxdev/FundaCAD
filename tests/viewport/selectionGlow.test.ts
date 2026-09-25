import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { glowFade, makeSelectionGlow, screenCoverage } from "../../src/viewport/selectionGlow";
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

describe("a body filling the view does not wash the screen", () => {
  const camera = () => {
    const c = new THREE.PerspectiveCamera(45, 1.5, 0.1, 10000);
    c.position.set(0, -60, 45);
    c.lookAt(0, 0, 0);
    c.updateMatrixWorld();
    return c;
  };
  const box = (x: number, y: number, z: number) =>
    new THREE.Box3(new THREE.Vector3(-x / 2, -y / 2, -z / 2), new THREE.Vector3(x / 2, y / 2, z / 2));
  const I = new THREE.Matrix4();

  it("measures a small part as a small share of the view", () => {
    expect(screenCoverage(box(10, 10, 10), I, camera())).toBeLessThan(0.1);
  });

  it("counts a plate the camera sits over as the whole view", () => {
    // The tester's 220 x 220 x 4 plate under a camera framed for a 20 mm box.
    expect(screenCoverage(box(220, 220, 4), I, camera())).toBeCloseTo(1, 1);
  });

  it("keeps full strength for an ordinary selection and fades a view-filling one", () => {
    expect(glowFade(0.2)).toBe(1);
    expect(glowFade(1)).toBeCloseTo(0.25);
    expect(glowFade(0.7)).toBeLessThan(1);
    expect(glowFade(0.7)).toBeGreaterThan(0.25);
  });

  it("sets the fade per draw, since the material is shared", () => {
    const geometry = new THREE.BoxGeometry(220, 220, 4);
    const glow = makeSelectionGlow(geometry, "select");
    glow.updateMatrixWorld();
    const mat = glow.material as THREE.ShaderMaterial;
    glow.onBeforeRender(null as never, null as never, camera(), geometry, mat, null as never);
    expect(mat.uniforms.uFade!.value).toBeCloseTo(0.25);
  });
});
