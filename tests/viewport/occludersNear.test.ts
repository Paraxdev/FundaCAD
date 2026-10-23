// A sight ray to an edge near the pointer is cast through only the bodies near
// the pointer ray, and must hit exactly what a cast through every body hits.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { meshesNearRay } from "../../src/viewport/picking";

const W = 800,
  H = 600;

function field(seed: number): THREE.Mesh[] {
  let x = seed;
  const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
  const out: THREE.Mesh[] = [];
  for (let i = 0; i < 400; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1 + rnd() * 6, 1 + rnd() * 6, 1 + rnd() * 6));
    m.position.set((rnd() - 0.5) * 120, (rnd() - 0.5) * 120, (rnd() - 0.5) * 120);
    m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
    m.updateMatrixWorld(true);
    out.push(m);
  }
  return out;
}

function cameras(): THREE.Camera[] {
  const p = new THREE.PerspectiveCamera(45, W / H, 0.1, 2000);
  p.position.set(150, -170, 130);
  p.zoom = 1.7;
  const o = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 2000);
  o.position.set(-160, 140, 120);
  o.zoom = 1.3;
  for (const c of [p, o]) {
    c.up.set(0, 0, 1);
    c.lookAt(0, 0, 0);
    c.updateMatrixWorld(true);
    (c as THREE.PerspectiveCamera).updateProjectionMatrix();
  }
  return [p, o];
}

const ndc = (sx: number, sy: number) => new THREE.Vector2((sx / W) * 2 - 1, -(sy / H) * 2 + 1);

describe("meshesNearRay", () => {
  it("keeps every body a sight ray within the radius can hit", () => {
    const meshes = field(7);
    const ray = new THREE.Raycaster();
    let checked = 0;
    for (const cam of cameras()) {
      for (const [cx, cy] of [
        [400, 300],
        [90, 60],
        [710, 520],
        [260, 410],
      ] as const) {
        ray.setFromCamera(ndc(cx, cy), cam);
        const near = meshesNearRay(meshes, ray.ray.clone(), cam, H, 27);
        expect(near.length).toBeLessThan(meshes.length / 3);
        const sight = new THREE.Raycaster();
        for (let k = 0; k < 64; k++) {
          const a = (k / 64) * Math.PI * 2,
            d = (26 * ((k % 4) + 1)) / 4;
          sight.setFromCamera(ndc(cx + Math.cos(a) * d, cy + Math.sin(a) * d), cam);
          const all = sight.intersectObjects(meshes, false)[0];
          const some = sight.intersectObjects(near, false)[0];
          expect(some?.object).toBe(all?.object);
          if (all) checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});
