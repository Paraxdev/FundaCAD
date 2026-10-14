// A tool ghosts the bodies it previews into, and letting go has to give each one
// back exactly the finish it had: a glowing or clear-coated body that came back
// matte, or an x-rayed model that came back solid, would be the tool quietly
// editing the look of the part.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { BodyFinishLayer, type FinishOverlays, sameFinishMap } from "../../src/viewport/bodyFinish";
import { applyGlassLook, applyThinFilm, setRenderLowPower } from "../../src/viewport/render";
import { previewKey } from "../../src/viewport/materialPreview";
import type { BodyMesh, ModelView } from "../../src/viewport/render";
import { type BodyFinish, FINISH, finishOf } from "../../src/document/materials";

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
    f.bodyFinish = { a: { ...FINISH, roughness: 0.5, emissive: 0.6 } };
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
    f.bodyFinish = { a: { ...FINISH, roughness: 0.5, opacity: 0.1 } };
    f.apply({ ...base, peek: new Set(["a"]) });
    expect(mat(a).opacity).toBeCloseTo(0.1);
  });
});

// One case per field: a field missing from a key makes its edit a silent no op.
const OPTICS: Partial<BodyFinish>[] = [
  { ior: 2.42 }, { thickness: 20 }, { dispersion: 5 }, { attenuationColor: "#2a8f6a" },
  { attenuationDistance: 15 }, { iridescence: 0.6 }, { specularColor: "#ffd0a0" },
];

describe("glass and thin film reach the screen", () => {
  const glass: BodyFinish = { ...FINISH, metalness: 0, roughness: 0.05, opacity: 0.25 };

  it("counts a change to any one optical field as a different finish", () => {
    for (const d of OPTICS) {
      expect(sameFinishMap({ a: glass }, { a: { ...glass, ...d } }), JSON.stringify(d)).toBe(false);
    }
    expect(sameFinishMap({ a: glass }, { a: { ...glass } })).toBe(true);
  });

  it("renders a new swatch for a change to any one optical field", () => {
    const m = { id: "g", name: "G", color: "#cfe4ee", metalness: 0, roughness: 0.05, opacity: 0.25 };
    for (const d of OPTICS) expect(previewKey({ ...m, ...d }), JSON.stringify(d)).not.toBe(previewKey(m));
  });

  it("copies IOR, thickness, tint and dispersion onto a glass material", () => {
    const m = new THREE.MeshPhysicalMaterial();
    const f = finishOf({
      id: "d", name: "D", color: "#ffffff", metalness: 0, opacity: 0.1,
      ior: 2.42, thickness: 12, dispersion: 5, attenuationColor: "#2a8f6a", attenuationDistance: 20,
    });
    expect(applyGlassLook(m, f, false)).toBe(true);
    expect([m.ior, m.thickness, m.dispersion, m.attenuationDistance]).toEqual([2.42, 12, 5, 20]);
    expect(m.attenuationColor.getHexString()).toBe("2a8f6a");
    expect(m.transmission).toBeGreaterThan(0);
    expect(m.transparent).toBe(false);
  });

  it("keeps an old glass at the look it always had", () => {
    const m = new THREE.MeshPhysicalMaterial();
    applyGlassLook(m, glass, false);
    expect([m.ior, m.thickness, m.dispersion, m.attenuationDistance]).toEqual([1.5, 3, 0, Infinity]);
    expect(m.attenuationColor.getHexString()).toBe("ffffff");
  });

  it("drops to plain alpha on a ghost and on a weak machine, dispersion and film with it", () => {
    const f: BodyFinish = { ...glass, dispersion: 5, iridescence: 0.6 };
    for (const [ghost, low] of [[true, false], [false, true]] as const) {
      setRenderLowPower(false);
      const m = new THREE.MeshPhysicalMaterial();
      expect(applyGlassLook(m, f, false)).toBe(true);
      applyThinFilm(m, f, false);
      expect(m.dispersion * m.iridescence).toBeGreaterThan(0);
      setRenderLowPower(low);
      expect(applyGlassLook(m, f, ghost)).toBe(false);
      applyThinFilm(m, f, ghost);
      expect([m.transmission, m.dispersion, m.iridescence]).toEqual([0, 0, 0]);
    }
    setRenderLowPower(false);
  });

  it("leaves a plain Standard material alone", () => {
    const m = new THREE.MeshStandardMaterial();
    const before = JSON.stringify(m.toJSON());
    expect(applyGlassLook(m, { ...glass, dispersion: 5 }, false)).toBe(false);
    applyThinFilm(m, { ...glass, iridescence: 1, specularColor: "#ff0000" }, false);
    expect(JSON.stringify(m.toJSON())).toBe(before);
  });

  it("puts the thin film and highlight tint on, and takes them off for a ghost", () => {
    const m = new THREE.MeshPhysicalMaterial();
    const f: BodyFinish = { ...FINISH, iridescence: 0.6, specularColor: "#ffd0a0" };
    applyThinFilm(m, f, false);
    expect(m.iridescence).toBe(0.6);
    expect(m.specularColor.getHexString()).toBe("ffd0a0");
    applyThinFilm(m, f, true);
    expect(m.iridescence).toBe(0);
    expect(m.specularColor.getHexString()).toBe("ffffff");
  });
});
