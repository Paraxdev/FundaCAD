// Sheen, anisotropy and scatter on the Realtime physical material. Bodies have
// no uv attribute, so anisotropy brings its own tangent frame or three's
// derivative frame is all zeros and the highlight goes NaN.

import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { BodyFinishLayer, type FinishOverlays, finishKey } from "../../src/viewport/bodyFinish";
import {
  applyFinishFields,
  applyGlassLook,
  setRenderLowPower,
  type BodyMesh,
  type ModelView,
} from "../../src/viewport/render";
import { dressPreview, previewKey } from "../../src/viewport/materialPreview";
import { getPatch } from "../../src/viewport/shaderPatches";
import { type BodyFinish, FINISH } from "../../src/document/materials";

const program = (m: THREE.Material) => {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  };
  m.onBeforeCompile(shader as never, {} as never);
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  shader.fragmentShader = shader.fragmentShader.replace(/#include <(\w+)>/g, (_, n: string) => chunks[n] ?? "");
  return shader;
};

function body(id: string): BodyMesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial());
  return {
    id,
    name: id,
    faceStart: 0,
    faceCount: 1,
    mesh,
    faceIds: [0],
    baseColors: new Float32Array(9),
    faceTriangles: new Map(),
  } as unknown as BodyMesh;
}

function layer(b: BodyMesh) {
  const model = { bodies: [b], edges: [] } as unknown as ModelView;
  return new BodyFinishLayer({
    model: () => model,
    scene: () => ({ renderer: { shadowMap: { enabled: false } } }) as never,
    faceIdToBodyId: () => b.id,
    addToScene: () => {},
    requestRender: () => {},
    savedMats: () => new Map(),
  });
}

const base: FinishOverlays = { xray: false, stale: false, wireframe: false };
const ZUP = new THREE.Vector3(0, 0, 1);
const silk: BodyFinish = { ...FINISH, sheen: 0.4, anisotropy: 0.6 };
const axisOf = (m: THREE.Material) =>
  (getPatch(m, "anisotropy")!.uniforms!["uAnisoAxis"]!.value as THREE.Vector3).toArray();

afterEach(() => setRenderLowPower(false));

describe("applyFinishFields", () => {
  it("puts sheen on in a lifted body colour", () => {
    const m = new THREE.MeshPhysicalMaterial();
    applyFinishFields(m, silk, false, "#ff0000", ZUP);
    expect(m.sheen).toBe(0.4);
    expect(m.sheenRoughness).toBe(0.8);
    expect(m.sheenColor.r).toBeCloseTo(1);
    expect(m.sheenColor.g).toBeGreaterThan(0.2);
    expect(m.sheenColor.g).toBeLessThan(1);
  });

  it("gives anisotropy its own tangent frame along the axis", () => {
    const m = new THREE.MeshPhysicalMaterial();
    applyFinishFields(m, silk, false, "#808080", new THREE.Vector3(1, 0, 0));
    expect(m.anisotropy).toBe(0.6);
    const fs = program(m).fragmentShader;
    expect(fs.indexOf("mat3 tbn = getTangentFrame")).toBeGreaterThan(0);
    expect(fs.indexOf("tbn = mat3(aT")).toBeGreaterThan(fs.indexOf("mat3 tbn = getTangentFrame"));
    expect(fs.indexOf("material.anisotropy *= aFade")).toBeGreaterThan(fs.indexOf("material.alphaT = mix"));
    expect(axisOf(m)).toEqual([1, 0, 0]);
  });

  it("changes the axis through the bound uniform, with no new program", () => {
    const m = new THREE.MeshPhysicalMaterial();
    applyFinishFields(m, silk, false, "#808080", ZUP);
    const u = program(m).uniforms["uAnisoAxis"]!;
    const v = m.version;
    applyFinishFields(m, silk, false, "#808080", new THREE.Vector3(0, 1, 0));
    expect(m.version).toBe(v);
    expect((u.value as THREE.Vector3).toArray()).toEqual([0, 1, 0]);
  });

  it("drops sheen and anisotropy on a ghost and on the low tier", () => {
    for (const [ghost, low] of [
      [true, false],
      [false, true],
    ] as const) {
      setRenderLowPower(false);
      const m = new THREE.MeshPhysicalMaterial();
      applyFinishFields(m, silk, false, "#808080", ZUP);
      setRenderLowPower(low);
      applyFinishFields(m, silk, ghost, "#808080", ZUP);
      expect([m.sheen, m.anisotropy], `ghost ${ghost} low ${low}`).toEqual([0, 0]);
      expect(getPatch(m, "anisotropy")).toBeUndefined();
    }
  });

  it("leaves a plain Standard material alone", () => {
    const m = new THREE.MeshStandardMaterial();
    applyFinishFields(m, { ...silk, scatterDistance: 2 }, false, "#808080", ZUP);
    expect("sheen" in m).toBe(false);
    expect(getPatch(m, "anisotropy")).toBeUndefined();
  });

  it("blurs what is seen through only on a see-through finish", () => {
    const glass: BodyFinish = { ...FINISH, metalness: 0, roughness: 0.05, opacity: 0.25, scatterDistance: 2 };
    const g = new THREE.MeshPhysicalMaterial();
    expect(applyGlassLook(g, glass, false)).toBe(true);
    applyFinishFields(g, glass, false, "#808080", ZUP);
    expect(getPatch(g, "scatter")).toBeDefined();
    expect(program(g).uniforms["uScatter"]!.value).toBe(2);
    const opaque = new THREE.MeshPhysicalMaterial();
    applyGlassLook(opaque, { ...glass, opacity: 1 }, false);
    applyFinishFields(opaque, { ...glass, opacity: 1 }, false, "#808080", ZUP);
    expect(getPatch(opaque, "scatter")).toBeUndefined();
    applyGlassLook(g, glass, true);
    applyFinishFields(g, glass, true, "#808080", ZUP);
    expect(getPatch(g, "scatter")).toBeUndefined();
  });
});

describe("BodyFinishLayer finish fields", () => {
  it("streaks along the relief axis when the body has ridges, world Z otherwise", () => {
    const b = body("a");
    const f = layer(b);
    f.bodyFinish = { a: silk };
    f.apply(base);
    const m = b.mesh.material as THREE.MeshPhysicalMaterial;
    expect([m.sheen, m.anisotropy]).toEqual([0.4, 0.6]);
    expect(axisOf(m)).toEqual([0, 0, 1]);
    f.setRelief({ all: { axis: [1, 0, 0], pitch: 0.2, depth: 0.35 } });
    f.apply(base);
    expect(axisOf(m)).toEqual([1, 0, 0]);
    f.apply({ ...base, xray: true });
    expect([m.sheen, m.anisotropy]).toEqual([0, 0]);
    expect(getPatch(m, "anisotropy")).toBeUndefined();
  });

  it("does not leak the base's fields into a plain face slot", () => {
    const b = body("a");
    const f = layer(b);
    f.bodyFinish = { a: silk };
    f.faceFinish = { 0: { ...FINISH, roughness: 0.2 } };
    f.apply(base);
    const mats = b.mesh.material as THREE.MeshPhysicalMaterial[];
    expect(mats.length).toBe(2);
    expect(mats[0]!.anisotropy).toBe(0.6);
    expect([mats[1]!.sheen, mats[1]!.anisotropy]).toEqual([0, 0]);
    expect(getPatch(mats[1]!, "anisotropy")).toBeUndefined();
  });
});

describe("finish fields reach the keys", () => {
  it("counts each field in finishKey and the swatch key", () => {
    const m = { id: "a", name: "A", color: "#808080" };
    for (const d of [
      { sheen: 0.4 },
      { anisotropy: 0.6 },
      { flakes: 0.2 },
      { flakeSize: 0.3 },
      { scatterDistance: 2 },
      { castsLight: false },
    ]) {
      expect(finishKey({ ...FINISH, ...d }), JSON.stringify(d)).not.toBe(finishKey({ ...FINISH }));
      expect(previewKey({ ...m, ...d }), JSON.stringify(d)).not.toBe(previewKey(m));
    }
  });

  it("shows sheen and anisotropy on the swatch, and none for a plain material", () => {
    const silky = new THREE.MeshPhysicalMaterial();
    dressPreview(silky, { id: "a", name: "A", color: "#808080", sheen: 0.4, anisotropy: 0.6 });
    expect([silky.sheen, silky.anisotropy]).toEqual([0.4, 0.6]);
    expect(getPatch(silky, "anisotropy")).toBeDefined();
    const plain = new THREE.MeshPhysicalMaterial();
    dressPreview(plain, { id: "a", name: "A", color: "#808080" });
    expect([plain.sheen, plain.anisotropy]).toEqual([0, 0]);
  });
});
