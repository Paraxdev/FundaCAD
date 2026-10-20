import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { type BodyFinish, FINISH } from "../../src/document/materials";
import { MAX_EMISSIVE_INTENSITY } from "../../src/ui/renderPrefs";
import { materialSignature, mirrorBody } from "../../src/viewport/pathtrace/mirror";
import { traceMaterialFrom, traceMaterialKey } from "../../src/viewport/pathtrace/materials";
import { applySurface } from "../../src/viewport/proceduralSurface";
import { applyClearcoat, applyGlassLook, applyThinFilm, CLEARCOAT_ROUGHNESS } from "../../src/viewport/render";

function finish(over: Partial<BodyFinish> = {}): BodyFinish {
  return { ...FINISH, thickness: 4, ...over };
}

function body(mat: THREE.Material | THREE.Material[]): THREE.Mesh {
  const g = new THREE.BoxGeometry(10, 10, 10);
  const m = new THREE.Mesh(g, mat);
  m.userData.owner = { id: "body1" };
  return m;
}

function traced(src: THREE.Mesh, slot = 0): THREE.MeshPhysicalMaterial {
  const mats = mirrorBody(src).material;
  return (Array.isArray(mats) ? mats[slot] : mats) as THREE.MeshPhysicalMaterial;
}

function glass(over: Partial<BodyFinish> = {}): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial();
  expect(applyGlassLook(mat, finish({ opacity: 0.2, metalness: 0, ...over }), false)).toBe(true);
  return mat;
}

describe("path tracer material per finish key", () => {
  it("metalness and roughness", () => {
    const m = traced(body(new THREE.MeshPhysicalMaterial({ metalness: 0.8, roughness: 0.25 })));
    expect(m.metalness).toBeCloseTo(0.8);
    expect(m.roughness).toBeCloseTo(0.25);
  });

  it("opacity becomes solid glass with its IOR, tint and dispersion", () => {
    const m = traced(body(glass({ ior: 2.42, attenuationColor: "#2a8f6a", attenuationDistance: 20, dispersion: 5 })));
    expect(m.transmission).toBeGreaterThan(0.9);
    expect(m.ior).toBeCloseTo(2.42);
    expect(m.attenuationColor.getHexString()).toBe("2a8f6a");
    expect(m.attenuationDistance).toBe(20);
    expect(m.dispersion).toBe(5);
    expect(m.thickness).toBeGreaterThan(0);
  });

  it("glass with no thickness and no tint is still a solid, not a sheet", () => {
    const m = traced(body(glass({ thickness: 0, attenuationDistance: 0 })));
    expect(m.attenuationDistance).toBe(Infinity);
    const thinWall = m.thickness === 0 && m.attenuationDistance === Infinity;
    expect(thinWall).toBe(false);
  });

  it("an opaque body keeps no thickness", () => {
    expect(traced(body(new THREE.MeshPhysicalMaterial())).thickness).toBe(0);
  });

  it("emissive carries its glow as light", () => {
    const src = new THREE.MeshPhysicalMaterial({ emissive: 0x33ff66 });
    src.emissiveIntensity = 0.5 * MAX_EMISSIVE_INTENSITY;
    const m = traced(body(src));
    expect(m.emissive.getHexString()).toBe("33ff66");
    expect(m.emissiveIntensity).toBeCloseTo(2);
  });

  it("clearcoat with the lacquer's own roughness", () => {
    const src = new THREE.MeshPhysicalMaterial();
    applyClearcoat(src, 0.7);
    const m = traced(body(src));
    expect(m.clearcoat).toBeCloseTo(0.7);
    expect(m.clearcoatRoughness).toBeCloseTo(CLEARCOAT_ROUGHNESS);
  });

  it("iridescence and the specular tint", () => {
    const src = new THREE.MeshPhysicalMaterial();
    applyThinFilm(src, finish({ iridescence: 0.6, specularColor: "#ff8800" }), false);
    const m = traced(body(src));
    expect(m.iridescence).toBeCloseTo(0.6);
    expect(m.specularColor.getHexString()).toBe("ff8800");
  });

  it("a per face slot maps to the same mirror slot", () => {
    const a = new THREE.MeshPhysicalMaterial({ color: 0xff0000 });
    const b = glass({ ior: 1.33 });
    const src = body([a, b]);
    src.geometry.clearGroups();
    src.geometry.addGroup(0, 6, 0);
    src.geometry.addGroup(6, 30, 1);
    const mirror = mirrorBody(src);
    const mats = mirror.material as THREE.MeshPhysicalMaterial[];
    expect(mats).toHaveLength(2);
    expect(mats[0]!.color.getHexString()).toBe("ff0000");
    expect(mats[1]!.ior).toBeCloseTo(1.33);
    expect(mirror.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
  });
});

describe("material signature", () => {
  const edits: [string, (m: THREE.MeshPhysicalMaterial) => void][] = [
    ["ior", (m) => applyGlassLook(m, finish({ opacity: 0.2, metalness: 0, ior: 1.33 }), false)],
    ["attenuation", (m) => applyGlassLook(m, finish({ opacity: 0.2, metalness: 0, attenuationColor: "#2a8f6a", attenuationDistance: 20 }), false)],
    ["dispersion", (m) => applyGlassLook(m, finish({ opacity: 0.2, metalness: 0, dispersion: 2 }), false)],
    ["iridescence", (m) => applyThinFilm(m, finish({ iridescence: 0.5 }), false)],
    ["specular colour", (m) => applyThinFilm(m, finish({ specularColor: "#00ff00" }), false)],
    ["surface", (m) => applySurface(m, { kind: "noise", scale: 2, amount: 0.3, color: "#ff0000", colorAmount: 0.5 })],
  ];
  for (const [name, edit] of edits) {
    it(`changes on ${name}`, () => {
      const mat = glass();
      const b = body(mat);
      const before = materialSignature([b]);
      edit(mat);
      expect(materialSignature([b])).not.toBe(before);
    });
  }

  it("changes when a surface slider moves under the same key", () => {
    const mat = new THREE.MeshPhysicalMaterial();
    applySurface(mat, { kind: "noise", scale: 2, amount: 0.3, color: "#ff0000", colorAmount: 0.5 });
    const b = body(mat);
    const before = materialSignature([b]);
    applySurface(mat, { kind: "noise", scale: 2, amount: 0.3, color: "#ff0000", colorAmount: 0.9 });
    expect(materialSignature([b])).not.toBe(before);
  });
});

describe("a glow that lights nothing else, traced", () => {
  it("carries noLight to the traced material and into its key", () => {
    const src = new THREE.MeshPhysicalMaterial({ emissive: 0xffffff, emissiveIntensity: 2 });
    const plainKey = traceMaterialKey(src);
    src.userData.noLight = true;
    expect(traceMaterialKey(src)).not.toBe(plainKey);
    const t = traceMaterialFrom(src, true);
    expect(t.userData.noLight).toBe(true);
    delete src.userData.noLight;
    traceMaterialFrom(src, true, t);
    expect(t.userData.noLight).toBeUndefined();
  });
});
