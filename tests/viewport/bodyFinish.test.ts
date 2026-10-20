// A tool ghosts the bodies it previews into, and letting go has to give each one
// back exactly the finish it had: a glowing or clear-coated body that came back
// matte, or an x-rayed model that came back solid, would be the tool quietly
// editing the look of the part.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { BodyFinishLayer, type FinishOverlays, sameFinishMap } from "../../src/viewport/bodyFinish";
import { applyGlassLook, applyThinFilm, setRenderLowPower } from "../../src/viewport/render";
import { previewKey } from "../../src/viewport/materialPreview";
import { getPatch } from "../../src/viewport/shaderPatches";
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
const OPTICS: (Partial<Omit<BodyFinish, "thickness">> & { thickness?: number })[] = [
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

  it("falls back to the old 3 mm when it is not given the body", () => {
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

describe("BodyFinishLayer reference scan", () => {
  it("keeps a scan matte when it has no finish of its own", () => {
    const scan = Object.assign(body("s"), { scan: true as const });
    const solid = body("b");
    const f = layer([scan, solid]);
    f.apply(base);
    expect(mat(scan).metalness).toBe(0);
    expect(mat(scan).roughness).toBe(1);
    expect(mat(solid).metalness).toBe(FINISH.metalness);
    expect(mat(solid).roughness).toBe(FINISH.roughness);

    f.bodyFinish = { s: { ...FINISH, roughness: 0.3 } };
    f.apply(base);
    expect(mat(scan).roughness).toBe(0.3);
  });
});

describe("BodyFinishLayer relief", () => {
  const ridges = (pitch: number, axis: [number, number, number] = [0, 0, 1]) => ({ axis, pitch, depth: 0.35 });
  const program = (m: THREE.Material) => {
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    m.onBeforeCompile(shader as never, {} as never);
    return shader;
  };
  const shared = (m: THREE.Material) => getPatch(m, "relief")?.shared as Record<string, THREE.IUniform> | undefined;

  function slotted(id: string) {
    const b = body(id);
    const model = { bodies: [b], edges: [] } as unknown as ModelView;
    const f = new BodyFinishLayer({
      model: () => model,
      scene: () => ({ renderer: { shadowMap: { enabled: false } } }) as never,
      faceIdToBodyId: () => id,
      addToScene: () => {},
      requestRender: () => {},
      savedMats: () => new Map(),
    });
    f.faceFinish = { 0: { ...FINISH, roughness: 0.2 } };
    return { b, f };
  }

  it("is not there until something asks for it", () => {
    const a = body("a");
    const f = layer([a]);
    f.apply(base);
    expect(getPatch(mat(a), "relief")).toBeUndefined();
    f.setRelief({ bodies: { a: null } });
    f.apply(base);
    expect(getPatch(mat(a), "relief")).toBeUndefined();
  });

  it("starts each body's ridges at its own lowest point along the axis, in world space", () => {
    const a = body("a");
    const b = body("b");
    a.mesh.position.set(4, 0, 5);
    b.mesh.position.set(-2, 0, -3);
    const f = layer([a, b]);
    f.setRelief({ all: ridges(0.2, [0, 0, 2]), bodies: { b: ridges(0.2, [1, 0, 0]) } });
    f.apply(base);
    expect(shared(mat(a))!.uReliefOrigin!.value).toBeCloseTo(5, 9);
    expect((shared(mat(a))!.uReliefAxis!.value as THREE.Vector3).toArray()).toEqual([0, 0, 1]);
    expect(shared(mat(b))!.uReliefOrigin!.value).toBeCloseTo(-2, 9);
    expect(shared(mat(a))).not.toBe(shared(mat(b)));
  });

  it("keeps the origin while a drag moves the body and takes the new one on release", () => {
    const a = body("a");
    const f = layer([a]);
    f.setRelief({ all: ridges(0.2) });
    f.apply(base);
    a.mesh.position.z = 7;
    f.apply(base);
    expect(shared(mat(a))!.uReliefOrigin!.value).toBeCloseTo(0, 9);
    expect(f.refreshReliefOrigins()).toBe(true);
    f.apply(base);
    expect(shared(mat(a))!.uReliefOrigin!.value).toBeCloseTo(7, 9);
  });

  it("shares one uniform object between a body's base and face slot materials", () => {
    const { b, f } = slotted("a");
    f.setRelief({ all: ridges(0.2) });
    f.apply(base);
    const mats = b.mesh.material as THREE.Material[];
    expect(mats.length).toBe(2);
    expect(shared(mats[0]!)).toBeDefined();
    expect(shared(mats[1]!)).toBe(shared(mats[0]!));
    expect(program(mats[1]!).uniforms["uReliefPitch"]).toBe(program(mats[0]!).uniforms["uReliefPitch"]);
  });

  it("changes a pitch through the bound uniform, with no new program", () => {
    const a = body("a");
    const f = layer([a]);
    f.setRelief({ all: ridges(0.2) });
    f.apply(base);
    const m = mat(a);
    const key = m.customProgramCacheKey();
    const version = m.version;
    const bound = program(m).uniforms;
    f.setRelief({ all: { ...ridges(0.1), depth: 0.5 } });
    f.apply(base);
    expect(m.customProgramCacheKey()).toBe(key);
    expect(m.version).toBe(version);
    expect(bound["uReliefPitch"]!.value).toBe(0.1);
    expect(bound["uReliefDepth"]!.value).toBe(0.5);
  });

  it("drops while ghosted and comes back on the same uniform object", () => {
    const { b, f } = slotted("a");
    f.setRelief({ all: ridges(0.2) });
    f.apply(base);
    const mats = () => b.mesh.material as THREE.Material[];
    const u = shared(mats()[0]!);
    for (const o of [{ ...base, xray: true }, { ...base, stale: true }, { ...base, peek: new Set(["a"]) }]) {
      f.apply(o);
      for (const m of mats()) expect(getPatch(m, "relief")).toBeUndefined();
      f.apply(base);
      for (const m of mats()) expect(shared(m)).toBe(u);
    }
  });

  it("links the programs on stand ins before the live materials switch", async () => {
    const a = body("a");
    const model = { bodies: [a], edges: [] } as unknown as ModelView;
    let release!: () => void;
    const linked: THREE.Material[] = [];
    const f = new BodyFinishLayer({
      model: () => model,
      scene: () => ({ renderer: { shadowMap: { enabled: false } } }) as never,
      faceIdToBodyId: () => null,
      addToScene: () => {},
      requestRender: () => {},
      savedMats: () => new Map(),
      prepareMaterials: (obj) => {
        obj.traverse((o) => { if (o instanceof THREE.Mesh) linked.push(o.material as THREE.Material); });
        return new Promise<void>((r) => { release = r; });
      },
    });
    f.setRelief({ all: ridges(0.2) });
    f.apply(base);
    f.apply(base);
    expect(getPatch(mat(a), "relief")).toBeUndefined();
    expect(linked.length).toBe(1);
    expect(linked[0]).not.toBe(mat(a));
    expect(linked[0]!.customProgramCacheKey()).toContain("relief1");
    release();
    await Promise.resolve();
    expect(getPatch(mat(a), "relief")).toBeDefined();
    expect(mat(a).customProgramCacheKey()).toBe(linked[0]!.customProgramCacheKey());
    f.setRelief({ all: ridges(0.3) });
    f.apply(base);
    expect(linked.length).toBe(1);

    // A rebuild hands back a fresh material on the same key, already linked.
    a.mesh.material = new THREE.MeshStandardMaterial();
    f.apply(base);
    expect(getPatch(mat(a), "relief")).toBeDefined();
    expect(linked.length).toBe(1);
  });
});
