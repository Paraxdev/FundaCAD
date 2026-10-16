// Shadow maps are redrawn only when a caster or a shadow light changed, so a
// hover or a material edit does not cost six depth passes per point light.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { ShadowWatch } from "../../src/viewport/shadowWatch";

function scene() {
  const s = new THREE.Scene();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  body.castShadow = true;
  const overlay = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  const light = new THREE.PointLight(0xffffff, 0);
  light.castShadow = true;
  s.add(body, overlay, light);
  return { s, body, overlay, light };
}

describe("ShadowWatch", () => {
  it("sees the first frame and then nothing until a caster or a shadow light changes", () => {
    const { s, body, overlay, light } = scene();
    const w = new ShadowWatch();
    expect(w.changed(s)).toBe(true);
    expect(w.changed(s)).toBe(false);

    overlay.position.x = 5;
    (body.material as THREE.MeshStandardMaterial).emissiveIntensity = 3;
    expect(w.changed(s)).toBe(false);

    body.position.x = 1;
    expect(w.changed(s)).toBe(true);
    expect(w.changed(s)).toBe(false);

    light.position.y = 2;
    expect(w.changed(s)).toBe(true);
    light.shadow.camera.far = 7;
    light.shadow.camera.updateProjectionMatrix();
    expect(w.changed(s)).toBe(true);

    body.visible = false;
    expect(w.changed(s)).toBe(true);
    body.visible = true;
    expect(w.changed(s)).toBe(true);

    body.geometry.getAttribute("position").needsUpdate = true;
    expect(w.changed(s)).toBe(true);
    body.geometry = new THREE.BoxGeometry(2, 2, 2);
    expect(w.changed(s)).toBe(true);
    expect(w.changed(s)).toBe(false);
  });

  it("sees a new shadow light come in", () => {
    const { s } = scene();
    const w = new ShadowWatch();
    w.changed(s);
    const extra = new THREE.PointLight(0xffffff, 0);
    extra.castShadow = true;
    s.add(extra);
    expect(w.changed(s)).toBe(true);
  });
});
