// A tool ghosts the bodies it previews into, and letting go has to give each one
// back exactly the finish it had: a glowing or clear-coated body that came back
// matte, or an x-rayed model that came back solid, would be the tool quietly
// editing the look of the part.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { BodyFinishLayer, type FinishOverlays } from "../../src/viewport/bodyFinish";
import type { BodyMesh, ModelView } from "../../src/viewport/render";

function body(id: string): BodyMesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  return { id, name: id, faceStart: 0, faceCount: 1, mesh, faceIds: [0], baseColors: new Float32Array(9), faceTriangles: new Map() } as unknown as BodyMesh;
}

function layer(bodies: BodyMesh[]) {
  const model = { bodies, edges: [] } as unknown as ModelView;
  return new BodyFinishLayer({
    model: () => model,
    scene: () => ({ renderer: { shadowMap: { enabled: false } } }) as never,
    faceIdToBodyId: () => null,
    addToScene: () => {},
    requestRender: () => {},
    savedMats: () => new Map(),
  });
}

const base: FinishOverlays = { xray: false, stale: false, wireframe: false };
const mat = (b: BodyMesh) => b.mesh.material as THREE.MeshStandardMaterial;
const look = (b: BodyMesh) => {
  const m = mat(b);
  return { opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite, glow: m.emissiveIntensity };
};

describe("BodyFinishLayer peek", () => {
  it("ghosts only the peeked bodies and puts them back as they were", () => {
    const a = body("a");
    const b = body("b");
    const f = layer([a, b]);
    f.bodyFinish = { a: { metalness: 0.1, roughness: 0.5, opacity: 1, emissive: 0.6, clearcoat: 0 } };
    f.apply(base);
    const before = { a: look(a), b: look(b) };
    expect(before.a.glow).toBeGreaterThan(0);

    f.apply({ ...base, peek: new Set(["a"]) });
    expect(mat(a).opacity).toBeLessThan(1);
    expect(mat(a).transparent).toBe(true);
    expect(mat(a).depthWrite).toBe(false);
    expect(mat(a).emissiveIntensity).toBe(0);
    expect(look(b)).toEqual(before.b);

    f.apply({ ...base, peek: new Set() });
    expect({ a: look(a), b: look(b) }).toEqual(before);
  });

  it("never makes an x-rayed body less see-through, and x-ray survives the peek", () => {
    const a = body("a");
    const f = layer([a]);
    f.apply({ ...base, xray: true });
    const xray = look(a);
    f.apply({ ...base, xray: true, peek: new Set(["a"]) });
    expect(mat(a).opacity).toBeLessThanOrEqual(xray.opacity);
    f.apply({ ...base, xray: true });
    expect(look(a)).toEqual(xray);
  });

  it("keeps a body the user made fainter than the peek at its own opacity", () => {
    const a = body("a");
    const f = layer([a]);
    f.bodyFinish = { a: { metalness: 0.1, roughness: 0.5, opacity: 0.1, emissive: 0, clearcoat: 0 } };
    f.apply({ ...base, peek: new Set(["a"]) });
    expect(mat(a).opacity).toBeCloseTo(0.1);
  });
});
